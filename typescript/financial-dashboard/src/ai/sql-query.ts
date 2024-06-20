"use server";

import { rawDatabase as db } from "@/db";
import { openai } from "@ai-sdk/openai";
import { Step, Thread } from "@literalai/client";
import {
  generateText as generateTextWithoutMonitoring,
  type CoreMessage,
} from "ai";
import { type Database } from "better-sqlite3";

import { literalClient } from "@/lib/literal";

const generateText = literalClient.instrumentation.vercel.instrument(
  generateTextWithoutMonitoring
);

const getSqlSchema = (db: Database) => {
  return db
    .prepare<[], { sql: string }>(
      `
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name IN ('User', 'Order', 'OrderEntry', 'Product');
        `
    )
    .all()
    .map((row) => row.sql ?? "")
    .join("\n\n");
};

export type QueryResult<T = unknown> = {
  query: string;
  attempts: number;
  result: T[];
};

export const queryDatabase = async <T = unknown>(
  literalAiParent: Step,
  query: string,
  columnNames?: string[]
): Promise<QueryResult<T>> => {
  literalAiParent.input = { query, columnNames };

  const messages: CoreMessage[] = [
    {
      role: "system",
      content: [
        "Given the following SQLite tables, your job is to write queries given a user’s request.",
        "Escape table and column names with double quotes.",
        "",
        getSqlSchema(db),
        "",
        "Write a SQLite query for the following request:",
      ].join("\n"),
    },
    {
      role: "user",
      content: columnNames
        ? [
            query,
            "",
            "the output should have the following columns:",
            columnNames.join(", "),
          ].join("\n")
        : query,
    },
  ];

  let lastError: any = null;
  for (let attempts = 1; attempts <= 5; attempts++) {
    const generation = await generateText({
      literalAiParent,
      model: openai("gpt-3.5-turbo"),
      messages,
      temperature: 0.25,
    });

    const query =
      generation.text.match(/```sql\n((?:.|\n)+)\n```/)?.[1] ?? generation.text;

    try {
      const result = db.prepare(query).all() as T[];
      literalAiParent.output = { result, query, attempts };
      await literalAiParent.send();
      return { result, query, attempts };
    } catch (error) {
      messages.push(
        { role: "assistant", content: generation.text },
        { role: "user", content: "That query is invalid. Please try again." }
      );
      lastError = error;
    }
  }

  throw lastError;
};
