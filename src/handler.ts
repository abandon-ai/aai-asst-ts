import {Handler, SQSEvent} from "aws-lambda";
import OpenAI from "openai";
import {ChangeMessageVisibilityCommand, DeleteMessageCommand, SendMessageCommand, SQSClient} from "@aws-sdk/client-sqs";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {DynamoDBDocumentClient, UpdateCommand} from "@aws-sdk/lib-dynamodb";
import {Redis} from "@upstash/redis";
import {functionHandlerMap, TelegramFunctions} from "./tools/telegram";

export const sqsClient = new SQSClient({
  region: "ap-northeast-1",
});

const ddbClient = new DynamoDBClient({
  region: "ap-northeast-1",
});

export const ddbDocClient = DynamoDBDocumentClient.from(ddbClient, {
  marshallOptions: {
    convertEmptyValues: true,
    removeUndefinedValues: true,
  },
});

export const redisClient = Redis.fromEnv();

const openai = new OpenAI();

export const handler: Handler = async (event: SQSEvent, context) => {
  const records = event.Records;
  for (const record of records) {
    const {messageAttributes, body, receiptHandle} = record;
    const intent = messageAttributes?.intent?.stringValue || undefined;
    const from = messageAttributes?.from?.stringValue || undefined;

    const randomSecond = Math.floor(Math.random() * 100) + 100;
    if (intent === 'threads.runs.create') {
      if (from === "telegram") {
        const {thread_id, assistant_id, update_id} = JSON.parse(body);
        try {
          const {id: run_id} = await openai.beta.threads.runs.create(thread_id, {
            assistant_id,
            additional_instructions: 'You are a telegram bot now. You will receive a update from telegram API. Then, you should send message to target chat.',
            tools: TelegramFunctions,
          })
          await sqsClient.send(new SendMessageCommand({
            QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
            MessageBody: JSON.stringify({
              thread_id,
              run_id,
              assistant_id,
              update_id,
            }),
            MessageAttributes: {
              intent: {
                DataType: 'String',
                StringValue: 'threads.runs.retrieve'
              },
            },
            MessageGroupId: `${assistant_id}-${thread_id}`,
          }))
          await ddbDocClient.send(new UpdateCommand({
            TableName: "abandonai-prod",
            Key: {
              PK: `ASST#${assistant_id}`,
              SK: `THREAD#${thread_id}`,
            },
            ExpressionAttributeNames: {
              "#runs": "runs",
              "#updated": "updated",
            },
            ExpressionAttributeValues: {
              ":empty_list": [],
              ":runs": [run_id],
              ":updated": Math.floor(Date.now() / 1000),
            },
            UpdateExpression:
              "SET #runs = list_append(if_not_exists(#runs, :empty_list), :runs), #updated = :updated",
          }))
        } catch (e) {
          console.log("Failed to create run", e);
          await sqsClient.send(new ChangeMessageVisibilityCommand({
            QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
            ReceiptHandle: receiptHandle,
            VisibilityTimeout: 10,
          })).catch((e) => {
            console.log("Failed to change message visibility", e);
          });
          console.log("Changed message visibility to 10 seconds");
        }
      } else {
        console.log("Not from telegram");
        await sqsClient.send(new DeleteMessageCommand({
          QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
          ReceiptHandle: receiptHandle,
        }))
      }
    } else if (intent === 'threads.runs.retrieve') {
      const {thread_id, run_id, assistant_id} = JSON.parse(body);
      console.log(assistant_id);
      console.log(thread_id);
      console.log(run_id);
      try {
        const {status, required_action} = await openai.beta.threads.runs.retrieve(thread_id, run_id);
        console.log(status);
        switch (status) {
          case "queued":
          case "in_progress":
            await sqsClient.send(new ChangeMessageVisibilityCommand({
              QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
              ReceiptHandle: receiptHandle,
              VisibilityTimeout: 10,
            })).catch((e) => {
              console.log("Failed to change message visibility", e);
            })
            console.log("Changed message visibility to 10 seconds");
            break;
          case "requires_action":
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
              ReceiptHandle: receiptHandle,
            }));
            if (!required_action) {
              console.log("Required action not found");
              break;
            }
            const tool_calls = required_action.submit_tool_outputs.tool_calls;
            let tool_outputs_promises = [];
            for (const toolCall of tool_calls) {
              const function_name = toolCall.function.name;
              console.log("function_name", function_name);
              const handler = functionHandlerMap[function_name!];
              if (handler) {
                // Instead of awaiting each handler, push the promise into an array
                tool_outputs_promises.push(handler(toolCall, assistant_id));
              } else {
                console.log(`Function ${function_name} not found`);
              }
            }
            if (tool_outputs_promises.length === 0) {
              console.log("No tool outputs found");
              break;
            }
            const tool_outputs = await Promise.all(tool_outputs_promises);
            try {
              openai.beta.threads.runs.submitToolOutputs(thread_id, run_id, {
                tool_outputs,
              });
            } catch (e) {
              console.log("Failed to submit tool outputs", e);
            }
            break;
          case "cancelling":
          case "completed":
          case "failed":
          case "cancelled":
          case "expired":
          default:
            await sqsClient.send(new DeleteMessageCommand({
              QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
              ReceiptHandle: receiptHandle,
            }));
            break;
        }
      } catch (e) {
        console.log("Failed to retrieve run", e);
      }
    } else {
      console.log("Unknown intent", intent);
      await sqsClient.send(new DeleteMessageCommand({
        QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
        ReceiptHandle: receiptHandle,
      }));
    }
    // sleep randomSecond
    await new Promise((resolve) => setTimeout(resolve, randomSecond));
  }
  console.log(`Successfully processed ${records.length} records.`);
  return {
    success: true,
    count: records.length,
  };
}