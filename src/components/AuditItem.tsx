"use client";

import { useState } from "react";
import { RatingMark } from "./Gauge";
import { formatBytes, formatCell, formatMs } from "@/lib/format";
import type { NormalizedAudit } from "@/lib/types";

/** Rende i link markdown che Lighthouse inserisce nelle descrizioni. */
function MarkdownText({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <a
        key={key++}
        href={match[2]}
        target="_blank"
        rel="noreferrer"
        className="text-accent underline underline-offset-2"
      >
        {match[1]}
      </a>,
    );
    lastIndex = pattern.lastIndex;
  }
  if (lastIndex < text.length) parts.push(text.slice(lastIndex));

  return <>{parts}</>;
}

function DetailTable({ audit }: { audit: NormalizedAudit }) {
  const table = audit.table;
  if (!table) return null;

  const headings = table.headings.filter((heading) => heading.key);
  if (headings.length === 0) return null;

  return (
    <div className="mt-3 overflow-x-auto rounded border border-border">
      <table className="w-full min-w-[32rem] text-xs">
        <thead>
          <tr className="bg-surface-alt text-left text-ink-muted">
            {headings.map((heading, index) => (
              <th key={index} className="px-3 py-2 whitespace-nowrap">
                {heading.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.items.map((item, rowIndex) => (
            <tr key={rowIndex} className="border-t border-border align-top">
              {headings.map((heading, colIndex) => {
                const cell = formatCell(
                  heading.key ? item[heading.key] : null,
                  heading.valueType,
                );
                return (
                  <td
                    key={colIndex}
                    className={`px-3 py-2 ${
                      cell.code ? "font-mono text-[11px]" : ""
                    }`}
                  >
                    {cell.href ? (
                      <a
                        href={cell.href}
                        target="_blank"
                        rel="noreferrer"
                        className="text-accent break-all underline underline-offset-2"
                      >
                        {cell.text}
                      </a>
                    ) : (
                      <span className="break-words">{cell.text}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      {table.totalItems > table.items.length ? (
        <p className="border-t border-border bg-surface-alt px-3 py-2 text-xs text-ink-muted">
          Mostrate {table.items.length} righe su {table.totalItems}. L&apos;elenco
          completo è nel report Lighthouse originale.
        </p>
      ) : null}
    </div>
  );
}

export function AuditItem({ audit }: { audit: NormalizedAudit }) {
  const [open, setOpen] = useState(false);
  const hasDetail = Boolean(audit.table) || audit.warnings.length > 0;

  const savings: string[] = [];
  if (audit.savingsMs && audit.savingsMs >= 10) {
    savings.push(`${formatMs(audit.savingsMs)} risparmiabili`);
  }
  if (audit.savingsBytes && audit.savingsBytes > 1024) {
    savings.push(formatBytes(audit.savingsBytes));
  }

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-alt"
        aria-expanded={open}
      >
        <RatingMark score={audit.score} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span className="text-sm">{audit.title}</span>
            {audit.displayValue ? (
              <span className="text-sm text-ink-muted">
                — {audit.displayValue}
              </span>
            ) : null}
          </span>
          {savings.length > 0 ? (
            <span className="mt-0.5 block text-xs text-ink-faint">
              {savings.join(" · ")}
            </span>
          ) : null}
        </span>
        <span className="mt-0.5 shrink-0 text-xs text-ink-faint">
          {open ? "Chiudi" : "Dettagli"}
        </span>
      </button>

      {open ? (
        <div className="px-4 pb-4 pl-10">
          <p className="text-sm leading-relaxed text-ink-muted">
            <MarkdownText text={audit.description} />
          </p>

          {audit.warnings.length > 0 ? (
            <ul className="mt-3 space-y-1 rounded border border-average bg-average-soft px-3 py-2 text-xs text-ink">
              {audit.warnings.map((warning, index) => (
                <li key={index}>{warning}</li>
              ))}
            </ul>
          ) : null}

          {hasDetail ? <DetailTable audit={audit} /> : null}
        </div>
      ) : null}
    </div>
  );
}
