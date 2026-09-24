"use client";

import { useMemo, useState } from "react";
import Image from "next/image";
import { AuditItem } from "./AuditItem";
import { Gauge } from "./Gauge";
import { formatFieldValue } from "@/lib/format";
import { ratingFor } from "@/lib/lighthouse-scoring";
import { CATEGORY_IDS, CATEGORY_LABELS, membershipIn } from "@/lib/types";
import type {
  CategoryId,
  FieldData,
  NormalizedAudit,
  RunResult,
} from "@/lib/types";

const FIELD_RATING_LABELS: Record<string, string> = {
  FAST: "Buono",
  AVERAGE: "Da migliorare",
  SLOW: "Scarso",
};

const FIELD_RATING_COLORS: Record<string, string> = {
  FAST: "#0cce6b",
  AVERAGE: "#ffa400",
  SLOW: "#ff4e42",
};

function Section({
  title,
  count,
  children,
  defaultOpen = false,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  if (count === 0) return null;

  return (
    <section className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-surface"
        aria-expanded={open}
      >
        <span className="text-sm">
          {title}{" "}
          <span className="text-ink-faint">({count})</span>
        </span>
        <span className="text-xs text-ink-faint">{open ? "−" : "+"}</span>
      </button>
      {open ? <div className="border-t border-border">{children}</div> : null}
    </section>
  );
}

function FieldPanel({ field, title }: { field: FieldData; title: string }) {
  return (
    <div className="rounded-lg border border-border p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h3 className="text-sm">{title}</h3>
        {field.overallCategory ? (
          <span
            className="rounded px-2 py-0.5 text-xs"
            style={{
              backgroundColor: `${FIELD_RATING_COLORS[field.overallCategory]}22`,
              color: "#1f2933",
            }}
          >
            {FIELD_RATING_LABELS[field.overallCategory] ??
              field.overallCategory}
          </span>
        ) : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {field.metrics.map((metric) => (
          <div key={metric.id} className="rounded border border-border p-3">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs text-ink-muted">{metric.label}</span>
              <span
                className="text-sm tabular-nums"
                style={{ color: FIELD_RATING_COLORS[metric.category] }}
              >
                {formatFieldValue(metric)}
              </span>
            </div>
            <div className="mt-2 flex h-1.5 overflow-hidden rounded-full bg-surface-alt">
              {metric.distributions.map((distribution, index) => (
                <span
                  key={index}
                  style={{
                    width: `${distribution.proportion * 100}%`,
                    backgroundColor: ["#0cce6b", "#ffa400", "#ff4e42"][index],
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface GroupedAudits {
  opportunities: NormalizedAudit[];
  diagnostics: NormalizedAudit[];
  passed: NormalizedAudit[];
  informative: NormalizedAudit[];
  notApplicable: NormalizedAudit[];
  manual: NormalizedAudit[];
}

function groupAudits(
  audits: NormalizedAudit[],
  category: CategoryId,
): GroupedAudits {
  const group: GroupedAudits = {
    opportunities: [],
    diagnostics: [],
    passed: [],
    informative: [],
    notApplicable: [],
    manual: [],
  };

  for (const audit of audits) {
    const membership = membershipIn(audit, category);
    // Lo stesso audit può comparire in più categorie: lo mostriamo in ognuna,
    // come fa il report Lighthouse ufficiale.
    if (!membership) continue;
    // Le metriche hanno una sezione dedicata sopra il report.
    if (membership.group === "metrics") continue;

    if (audit.scoreDisplayMode === "manual") {
      group.manual.push(audit);
    } else if (audit.scoreDisplayMode === "notApplicable") {
      group.notApplicable.push(audit);
    } else if (audit.scoreDisplayMode === "informative") {
      group.informative.push(audit);
    } else if (audit.isFailing) {
      // Lighthouse separa le opportunità (con risparmio stimato) dalla
      // diagnostica pura: manteniamo la stessa distinzione.
      if (audit.isOpportunity || (audit.savingsMs ?? 0) > 0) {
        group.opportunities.push(audit);
      } else {
        group.diagnostics.push(audit);
      }
    } else {
      group.passed.push(audit);
    }
  }

  const weightIn = (audit: NormalizedAudit) =>
    membershipIn(audit, category)?.weightPct ?? 0;

  group.opportunities.sort((a, b) => (b.savingsMs ?? 0) - (a.savingsMs ?? 0));
  group.diagnostics.sort(
    (a, b) => weightIn(b) - weightIn(a) || (a.score ?? 0) - (b.score ?? 0),
  );
  group.passed.sort((a, b) => a.title.localeCompare(b.title, "it"));

  return group;
}

function AuditList({ audits }: { audits: NormalizedAudit[] }) {
  return (
    <div>
      {audits.map((audit) => (
        <AuditItem key={audit.id} audit={audit} />
      ))}
    </div>
  );
}

export function PageReport({ run }: { run: RunResult }) {
  const [category, setCategory] = useState<CategoryId>("performance");
  const grouped = useMemo(
    () => groupAudits(run.audits, category),
    [run.audits, category],
  );

  const failingCount = (categoryId: CategoryId) =>
    run.audits.filter((audit) => {
      const membership = membershipIn(audit, categoryId);
      return Boolean(membership) && audit.isFailing && membership!.group !== "metrics";
    }).length;

  return (
    <div className="space-y-6">
      <header className="rounded-lg border border-border bg-surface p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <a
              href={run.requestedUrl}
              target="_blank"
              rel="noreferrer"
              className="block truncate text-base text-accent underline underline-offset-2"
            >
              {run.requestedUrl}
            </a>
            <p className="mt-1 text-xs text-ink-muted">
              {run.strategy === "mobile" ? "Mobile" : "Desktop"} ·{" "}
              {run.fetchTime
                ? new Date(run.fetchTime).toLocaleString("it-IT")
                : "—"}{" "}
              · Lighthouse {run.lighthouseVersion}
            </p>
            {run.finalUrl !== run.requestedUrl ? (
              <p className="mt-1 text-xs text-average">
                Reindirizzato a {run.finalUrl}
              </p>
            ) : null}
          </div>

          {run.screenshot ? (
            <Image
              src={run.screenshot}
              alt={`Screenshot di ${run.requestedUrl}`}
              width={96}
              height={170}
              unoptimized
              className="h-auto w-20 rounded border border-border bg-background"
            />
          ) : null}
        </div>

        <div className="mt-5 flex flex-wrap gap-6">
          {CATEGORY_IDS.map((categoryId) => (
            <Gauge
              key={categoryId}
              score={run.categories[categoryId]?.score ?? null}
              label={CATEGORY_LABELS[categoryId]}
              size="md"
            />
          ))}
        </div>

        {run.runWarnings.length > 0 ? (
          <ul className="mt-4 space-y-1 rounded border border-average bg-average-soft px-3 py-2 text-xs">
            {run.runWarnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        ) : null}
      </header>

      <section className="rounded-lg border border-border p-5">
        <h2 className="mb-4 text-sm text-ink-muted">
          Metriche di laboratorio
        </h2>
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {run.metrics.map((metric) => {
            const rating = ratingFor(metric.score);
            const color =
              rating === "pass"
                ? "#0a7d43"
                : rating === "average"
                  ? "#9a6200"
                  : rating === "fail"
                    ? "#b3231a"
                    : "#5f6771";
            return (
              <div key={metric.id} className="border-l-2 pl-3" style={{ borderColor: color }}>
                <p className="text-xs text-ink-muted">{metric.title}</p>
                <p className="text-lg tabular-nums" style={{ color }}>
                  {metric.displayValue ?? "—"}
                </p>
              </div>
            );
          })}
        </div>
      </section>

      {run.field ? (
        <FieldPanel
          field={run.field}
          title="Esperienza reale degli utenti — questa pagina (ultimi 28 giorni)"
        />
      ) : null}
      {run.fieldOrigin ? (
        <FieldPanel
          field={run.fieldOrigin}
          title="Esperienza reale degli utenti — intero sito"
        />
      ) : null}

      <div>
        <div className="mb-4 flex flex-wrap gap-2 border-b border-border">
          {CATEGORY_IDS.map((categoryId) => {
            const active = categoryId === category;
            const failing = failingCount(categoryId);
            return (
              <button
                key={categoryId}
                type="button"
                onClick={() => setCategory(categoryId)}
                className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                  active
                    ? "border-accent text-accent"
                    : "border-transparent text-ink-muted hover:text-ink"
                }`}
              >
                {CATEGORY_LABELS[categoryId]}
                {failing > 0 ? (
                  <span className="ml-1.5 rounded bg-fail-soft px-1.5 py-0.5 text-xs text-fail">
                    {failing}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>

        <div className="space-y-3">
          <Section
            title="Opportunità"
            count={grouped.opportunities.length}
            defaultOpen
          >
            <AuditList audits={grouped.opportunities} />
          </Section>
          <Section
            title="Diagnostica"
            count={grouped.diagnostics.length}
            defaultOpen
          >
            <AuditList audits={grouped.diagnostics} />
          </Section>
          <Section title="Informativi" count={grouped.informative.length}>
            <AuditList audits={grouped.informative} />
          </Section>
          <Section title="Controlli superati" count={grouped.passed.length}>
            <AuditList audits={grouped.passed} />
          </Section>
          <Section
            title="Da verificare manualmente"
            count={grouped.manual.length}
          >
            <AuditList audits={grouped.manual} />
          </Section>
          <Section
            title="Non applicabili"
            count={grouped.notApplicable.length}
          >
            <AuditList audits={grouped.notApplicable} />
          </Section>

          {grouped.opportunities.length === 0 &&
          grouped.diagnostics.length === 0 ? (
            <p className="rounded-lg border border-pass bg-pass-soft px-4 py-3 text-sm">
              Nessun audit da correggere in questa categoria.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
