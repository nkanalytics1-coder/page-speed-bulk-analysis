"use client";

import { useState } from "react";
import { formatBytes, formatMs, formatPercent, shortUrl } from "@/lib/format";
import { CATEGORY_LABELS } from "@/lib/types";
import type { ActionItem } from "@/lib/types";

const BAND_STYLES: Record<ActionItem["priorityBand"], string> = {
  Critica: "bg-fail-soft text-fail",
  Alta: "bg-average-soft text-[#9a6200]",
  Media: "bg-[#fff9e0] text-[#8a6d00]",
  Bassa: "bg-surface-alt text-ink-muted",
};

function Row({ item, rank }: { item: ActionItem; rank: number }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr
        className="cursor-pointer border-t border-border align-top hover:bg-surface"
        onClick={() => setOpen((value) => !value)}
      >
        <td className="px-3 py-3 text-xs text-ink-faint tabular-nums">{rank}</td>
        <td className="px-3 py-3">
          <span
            className={`inline-block rounded px-2 py-0.5 text-xs ${
              BAND_STYLES[item.priorityBand]
            }`}
          >
            {item.priorityBand}
          </span>
        </td>
        <td className="px-3 py-3">
          <span className="text-sm">{item.title}</span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            {CATEGORY_LABELS[item.category]}
            {item.meanImportance > 1.2
              ? " · su pagine importanti"
              : item.meanImportance < 0.8
                ? " · su pagine secondarie"
                : ""}
            {item.impactEstimated ? " · impatto stimato dal tempo" : ""}
          </span>
        </td>
        <td className="px-3 py-3 text-sm tabular-nums">
          {item.pagesAffected}
          <span className="ml-1 text-xs text-ink-faint">
            ({formatPercent(item.coverage)})
          </span>
        </td>
        <td className="px-3 py-3 text-sm tabular-nums">
          {item.impactEstimated
            ? "—"
            : `+${item.avgPointsRecoverable.toFixed(1)}`}
        </td>
        <td className="px-3 py-3 text-sm tabular-nums">
          {item.totalSavingsMs > 0 ? formatMs(item.totalSavingsMs) : "—"}
        </td>
        <td className="px-3 py-3 text-sm tabular-nums">
          {item.totalSavingsBytes > 0 ? formatBytes(item.totalSavingsBytes) : "—"}
        </td>
      </tr>
      {open ? (
        <tr className="border-t border-border bg-surface">
          <td />
          <td colSpan={6} className="px-3 py-4">
            <p className="max-w-3xl text-sm leading-relaxed text-ink-muted">
              {item.description.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")}
            </p>
            <p className="mt-3 text-xs text-ink-faint">
              Audit Lighthouse <code className="font-mono">{item.auditId}</code>{" "}
              · rilevato su {item.occurrences} analisi (
              {item.strategies
                .map((s) => (s === "mobile" ? "mobile" : "desktop"))
                .join(" e ")}
              )
            </p>
            <ul className="mt-2 space-y-0.5">
              {item.affectedUrls.slice(0, 10).map((url) => (
                <li key={url} className="text-xs">
                  <a
                    href={url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-accent underline underline-offset-2"
                  >
                    {shortUrl(url, 90)}
                  </a>
                </li>
              ))}
              {item.affectedUrls.length > 10 ? (
                <li className="text-xs text-ink-faint">
                  e altre {item.affectedUrls.length - 10} pagine
                </li>
              ) : null}
            </ul>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function ActionPlanTable({ items }: { items: ActionItem[] }) {
  if (items.length === 0) {
    return (
      <p className="rounded-lg border border-pass bg-pass-soft px-4 py-3 text-sm">
        Nessun audit fallito sulle pagine analizzate.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-[56rem] text-left">
        <thead className="bg-surface-alt text-xs text-ink-muted">
          <tr>
            <th className="px-3 py-2">#</th>
            <th className="px-3 py-2">Priorità</th>
            <th className="px-3 py-2">Azione</th>
            <th className="px-3 py-2">Pagine</th>
            <th className="px-3 py-2">Punti recuperabili</th>
            <th className="px-3 py-2">Tempo</th>
            <th className="px-3 py-2">Peso</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item, index) => (
            <Row key={item.auditId} item={item} rank={index + 1} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
