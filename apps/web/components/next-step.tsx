"use client";

import React, { useState, type FormEvent } from "react";

import styles from "./next-step.module.css";

const INTENT_OPTIONS = [
  {
    label: "Fix it with AI",
    value: "I want to use AI to fix this website.",
  },
  {
    label: "Send to a developer",
    value: "I want to send the implementation brief to a developer.",
  },
  {
    label: "Share with my team",
    value: "I want to share this research with my team or client.",
  },
] as const;

export function NextStep({
  benchmark,
  entryId,
  initialAnswer,
  scanId,
  waitlistPosition,
}: Readonly<{
  benchmark: Readonly<{ sample_size: number; average_score: number }> | null;
  entryId: string;
  initialAnswer: string | null;
  scanId: string;
  waitlistPosition: string;
}>) {
  const [answer, setAnswer] = useState(initialAnswer ?? "");
  const [answerState, setAnswerState] = useState("");
  const [saving, setSaving] = useState(false);

  async function saveAnswer(event: FormEvent) {
    event.preventDefault();
    await persistAnswer(answer);
  }

  async function persistAnswer(nextAnswer: string) {
    setAnswer(nextAnswer);
    setSaving(true);
    setAnswerState("Saving…");
    try {
      const response = await fetch(
        `/api/v1/waitlist/${encodeURIComponent(entryId)}/answer`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: nextAnswer }),
        },
      );
      setAnswerState(response.ok ? "Saved." : "Could not save. Try again.");
    } catch {
      setAnswerState("Could not save. Try again.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className={styles.block} id="next-step">
      <div className={styles.head}>
        <strong>What do you want to do next?</strong>
        <span className={styles.meta}>
          Waitlist #{waitlistPosition} ·{" "}
          {benchmark
            ? `Segment average ${Math.round(benchmark.average_score)} from ${benchmark.sample_size} scans`
            : "Benchmark forms after 30 eligible scans"}
        </span>
      </div>
      <div className={styles.options}>
        {INTENT_OPTIONS.map((option) => (
          <button
            aria-pressed={answer === option.value}
            className={styles.chip}
            disabled={saving}
            key={option.value}
            onClick={() => void persistAnswer(option.value)}
            type="button"
          >
            {option.label}
          </button>
        ))}
      </div>
      <details className={styles.custom}>
        <summary>Write your own next step</summary>
        <form onSubmit={(event) => void saveAnswer(event)}>
          <label className="sr-only" htmlFor={`report-feedback-${scanId}`}>
            Your next step
          </label>
          <textarea
            id={`report-feedback-${scanId}`}
            minLength={10}
            maxLength={2000}
            name="report_feedback"
            onChange={(event) => setAnswer(event.target.value)}
            placeholder="For example: I need an implementation plan for my team."
            required
            value={answer}
          />
          <button
            className="button button-secondary"
            disabled={saving}
            type="submit"
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </form>
      </details>
      <span aria-live="polite" className={styles.status}>
        {answerState}
      </span>
    </section>
  );
}
