export const runtime = "nodejs";
export const dynamic = "force-dynamic";

import {
  Attachment,
  IGenerationMessage,
  LiteralClient,
} from "@literalai/client";
import { NextRequest, NextResponse } from "next/server";
import OpenAI, { toFile } from "openai";
import { ReadableStream } from "stream/web";
import { Readable } from "stream";

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const literalClient = new LiteralClient();

export async function POST(req: NextRequest) {
  const data = await req.formData();
  const formAudio = data.get("audio") as File;
  const runId = data.get("runId") as string;

  if (!formAudio) {
    return new NextResponse("No audio file provided", { status: 400 });
  }

  // Create or retrieve the thread
  const thread = await literalClient
    .thread({ name: "Speech to Emoji Thread" })
    .upsert();

  // This is necessary to convert the Blob to a ReadableStream that can be uploaded to Literal
  const nodeStream = Readable.fromWeb(
    formAudio.stream() as ReadableStream<any>
  );

  // Upload the file to Literal and add it as an attachment
  const { objectKey } = await literalClient.api.uploadFile({
    content: nodeStream,
    threadId: thread.id,
    mime: "audio/webm",
  });
  const attachment = new Attachment({
    name: "Audio file",
    objectKey,
    mime: "audio/webm",
  });

  // Create the run with the attached audio file
  const run = await thread
    .step({
      id: runId,
      type: "run",
      name: "Speech to Emoji",
      input: {
        input: { content: "Audio file" },
        attachments: [attachment],
      },
    })
    .send();

  const start = new Date();

  // Convert the file to a format that OpenAI can process
  const webmArrayBuffer = await formAudio.arrayBuffer();
  const audioFile = await toFile(webmArrayBuffer, `${formAudio.name}.webm`);
  const { text: transcribedText } = await openai.audio.transcriptions.create({
    file: audioFile,
    model: "whisper-1",
    language: "en",
  });

  const end = new Date();

  const input: IGenerationMessage = {
    role: "user",
    content: "See attached audio file",
  };
  const output: IGenerationMessage = {
    role: "assistant",
    content: transcribedText,
  };

  // Create the Transcription step
  await run
    .step({
      type: "llm",
      name: "whisper-1",
      input,
      output,
      attachments: [attachment],
      startTime: start.toISOString(),
      endTime: end.toISOString(),
      generation: {
        type: "CHAT",
        provider: "openai",
        model: "whisper-1",
        messages: [input],
        messageCompletion: output,
      },
    })
    .send();

  return Response.json({ transcribedText });
}
