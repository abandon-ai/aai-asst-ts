import {SQSRecord} from "aws-lambda";
import redisClient from "../../utils/redisClient";
import openai from "../../utils/openai";
import sqsClient from "../../utils/sqsClient";
import {ChangeMessageVisibilityCommand, SendMessageCommand} from "@aws-sdk/client-sqs";
import backOffSecond from "../../utils/backOffSecond";

const Threads_messages_create = async (record: SQSRecord) => {
  const {messageAttributes, body, receiptHandle, messageId} = record;
  const from = messageAttributes?.from?.stringValue || undefined;
  const retryTimes = await redisClient.incr(messageId);

  console.log("threads.messages.create...retry times", retryTimes);
  if (from === "telegram") {
    // message is telegram's update data
    const {thread_id, message, assistant_id, chat_id, token} = JSON.parse(body);
    try {
      // If the thread is unlocked, then, you can run it.
      await openai.beta.threads.messages.create(thread_id as string, {
        role: "user",
        content: message,
      })
      console.log("threads.messages.create...success");
      // Queue to create a run of this thread.
      // When running, this thread will be blocked!
      // (When running) No more messages will be created, and no more runs.
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
          MessageBody: JSON.stringify({
            thread_id,
            assistant_id,
            token,
            chat_id,
            intent: "threads.runs.create",
          }),
          MessageAttributes: {
            intent: {
              StringValue: "threads.runs.create",
              DataType: "String",
            },
            from: {
              StringValue: from,
              DataType: "String",
            },
          },
          MessageGroupId: `${assistant_id}-${thread_id}`,
        }),
      )
      console.log("threads.runs.create...queued");
    } catch (e) {
      if (retryTimes === 1) {
        try {
          await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "post",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              chat_id,
              text: "Wait for a second!",
            }),
          })
        } catch (e) {
          console.log(e)
        }
      }
      console.log("threads.messages.create...wait", backOffSecond(retryTimes - 1))
      await sqsClient.send(new ChangeMessageVisibilityCommand({
        QueueUrl: process.env.AI_ASST_SQS_FIFO_URL,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: backOffSecond(retryTimes - 1),
      }))
      throw `threads.messages.create...the thread is blocked ${thread_id}`
    }
  } else {
    console.log("threads.messages.create...from error", from);
  }
}

export default Threads_messages_create;