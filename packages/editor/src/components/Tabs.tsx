export type TabKey = "collaborate" | "chaos" | "anomaly";

const TABS: { key: TabKey; label: string }[] = [
  { key: "collaborate", label: "Collaborate" },
  { key: "chaos", label: "Chaos" },
  { key: "anomaly", label: "Anomaly Lab" },
];

export function Tabs({ active, onChange }: { active: TabKey; onChange: (key: TabKey) => void }) {
  return (
    <div className="tabs" role="tablist" aria-label="Sections">
      {TABS.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={active === t.key}
          className={`tab-btn ${active === t.key ? "tab-btn-active" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
