import { contractValue, reputationOf, scoreOf } from '@agent-economy/engine';
import { type CompanyId, GOODS, type Good, type Role, type RunState } from '@agent-economy/schema';
import { useMemo } from 'react';
import { acceptedContracts, driverLabel, type EdgeFilter, tradeEdges } from '../derive.ts';
import { Chip, fmt } from './ui.tsx';

// The ring of companies in production-chain order, with one curved edge per trading pair.

const CHAIN: Role[] = ['miner', 'smelter', 'toolmaker', 'furniture_maker', 'mill', 'logger'];
const OK = '#0F766E';
const BAD = '#B91C1C';
const OPEN = '#94A3B8';
const DM = '#7C3AED';
const W = 800;
const H = 600;
const CX = 400;
const CY = 300;
const R = 205;

const initials = (name: string): string =>
  name
    .split(/\s+/)
    .map((w) => w[0] ?? '')
    .join('')
    .slice(0, 2)
    .toUpperCase();

export const STATUS_FILTERS: { id: EdgeFilter['status']; label: string }[] = [
  { id: 'all', label: 'All statuses' },
  { id: 'completed', label: 'Completed' },
  { id: 'defaulted', label: 'Defaulted' },
  { id: 'active', label: 'Still open' },
];

export function NetworkFilters({
  filter,
  onChange,
}: {
  filter: EdgeFilter;
  onChange: (f: EdgeFilter) => void;
}) {
  return (
    <div className="toolbar">
      <h1 style={{ marginRight: 'auto' }}>Trade network</h1>
      <fieldset className="pills" aria-label="Contract status filter">
        {STATUS_FILTERS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="pill"
            aria-pressed={filter.status === s.id}
            onClick={() => onChange({ ...filter, status: s.id })}
          >
            {s.label}
          </button>
        ))}
      </fieldset>
      <label className="field">
        Goods
        <select
          value={filter.good}
          onChange={(e) => onChange({ ...filter, good: e.target.value as Good | 'all' })}
        >
          <option value="all">All goods</option>
          {GOODS.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function Line({ color, dash }: { color: string; dash?: string }) {
  return (
    <svg width="22" height="6" aria-hidden="true">
      <line x1="0" y1="3" x2="22" y2="3" stroke={color} strokeWidth="3" strokeDasharray={dash} />
    </svg>
  );
}

function Legend() {
  return (
    <div className="legend muted" style={{ gap: '8px 18px' }}>
      <span>Line width = total contract value</span>
      <span className="legend-item">
        <Line color={OK} /> All completed
      </span>
      <span className="legend-item">
        <Line color={OPEN} /> Still open
      </span>
      <span className="legend-item">
        <Line color={BAD} dash="6 3" /> Any default
      </span>
      <span className="legend-item">
        <Line color={DM} dash="2 3" /> DMs only, no contract
      </span>
    </div>
  );
}

export function Network({
  state,
  filter,
  selected,
  onSelect,
}: {
  state: RunState;
  filter: EdgeFilter;
  selected: CompanyId | null;
  onSelect: (id: CompanyId) => void;
}) {
  const companies = useMemo(
    () =>
      Object.values(state.companies).sort((a, b) => {
        const ra = CHAIN.indexOf(a.roles[0]);
        const rb = CHAIN.indexOf(b.roles[0]);
        return ra === rb ? (a.id < b.id ? -1 : 1) : ra - rb;
      }),
    [state],
  );
  const edges = useMemo(() => tradeEdges(state, filter), [state, filter]);
  const pos = new Map<CompanyId, [number, number]>();
  const nodes = companies.map((c, i) => {
    const angle = -Math.PI / 2 + (i * Math.PI * 2) / companies.length;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    pos.set(c.id, [CX + R * cos, CY + R * sin]);
    const lr = R + 34;
    return {
      company: c,
      x: CX + R * cos,
      y: CY + R * sin,
      lx: CX + lr * cos,
      ly: CY + lr * sin + (sin > 0.3 ? 8 : sin < -0.3 ? -8 : 0),
      anchor: cos > 0.3 ? 'start' : cos < -0.3 ? 'end' : 'middle',
      isSelected: c.id === selected,
      bankrupt: c.standing.kind === 'bankrupt',
    } as const;
  });
  const maxValue = Math.max(1, ...edges.map((e) => e.value));
  const paths = edges.flatMap((e) => {
    const p = pos.get(e.a);
    const q = pos.get(e.b);
    if (p === undefined || q === undefined) return [];
    const mx = (p[0] + q[0]) / 2;
    const my = (p[1] + q[1]) / 2;
    const kx = mx + (CX - mx) * 0.35;
    const ky = my + (CY - my) * 0.35;
    const dmOnly = e.contracts === 0;
    const color = dmOnly ? DM : e.defaulted > 0 ? BAD : e.completed > 0 ? OK : OPEN;
    const touches = selected === null || e.a === selected || e.b === selected;
    return [
      {
        key: `${e.a}-${e.b}`,
        d: `M${p[0].toFixed(1)} ${p[1].toFixed(1)} Q${kx.toFixed(1)} ${ky.toFixed(1)} ${q[0].toFixed(1)} ${q[1].toFixed(1)}`,
        color,
        width: dmOnly ? 1.5 : 1 + (e.value / maxValue) * 6,
        dash: dmOnly ? '2 4' : e.defaulted > 0 ? '8 4' : undefined,
        opacity: touches ? 1 : 0.35,
        title: dmOnly
          ? `${e.dms} DMs, no contract`
          : `${e.contracts} contracts worth ${fmt(e.value)} · ${e.completed} completed · ${e.defaulted} defaulted`,
      },
    ];
  });
  return (
    <section className="card grow">
      <Legend />
      <svg
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={`Trade network of ${companies.length} companies arranged around the production chain`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
      >
        {paths.map((p) => (
          <path
            key={p.key}
            d={p.d}
            fill="none"
            stroke={p.color}
            strokeWidth={p.width}
            strokeDasharray={p.dash}
            strokeLinecap="round"
            opacity={p.opacity}
          >
            <title>{p.title}</title>
          </path>
        ))}
        {nodes.map((n) => (
          <a
            key={n.company.id}
            href={`#company-${n.company.id}`}
            aria-label={`Select ${n.company.name}`}
            onClick={(e) => {
              e.preventDefault();
              onSelect(n.company.id);
            }}
            style={{ opacity: n.bankrupt && !n.isSelected ? 0.6 : 1 }}
          >
            <title>{n.company.name}</title>
            <circle
              cx={n.x}
              cy={n.y}
              r={n.isSelected ? 22 : 19}
              fill="#FFFFFF"
              stroke={n.isSelected ? '#C2410C' : n.bankrupt ? '#9CA3AF' : '#374151'}
              strokeWidth={n.isSelected ? 3 : 1.25}
            />
            <text
              x={n.x}
              y={n.y + 4}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="#374151"
              fontFamily="IBM Plex Mono, monospace"
            >
              {initials(n.company.name)}
            </text>
            <text
              x={n.lx}
              y={n.ly}
              textAnchor={n.anchor}
              fontSize={13}
              fontWeight={n.isSelected ? 700 : 500}
              fill="#111827"
            >
              {n.company.name}
            </text>
            <text x={n.lx} y={n.ly + 15} textAnchor={n.anchor} fontSize={11} fill="#5B6472">
              {n.company.roles.join('+')} · {driverLabel(state, n.company.id)}
              {n.bankrupt ? ' · bankrupt' : ''}
            </text>
          </a>
        ))}
      </svg>
      <div className="muted">
        Companies sit around the ring in chain order: miners, smelters, toolmakers, furniture
        makers, mills, loggers. Click one to inspect it.
      </div>
    </section>
  );
}

export function SelectedCompany({
  state,
  filter,
  selected,
  onSelect,
  onOpen,
}: {
  state: RunState;
  filter: EdgeFilter;
  selected: CompanyId | null;
  onSelect: (id: CompanyId) => void;
  onOpen: (id: CompanyId) => void;
}) {
  const companies = Object.values(state.companies).sort((a, b) => (a.name < b.name ? -1 : 1));
  const company = selected === null ? undefined : state.companies[selected];
  const rank =
    company === undefined
      ? 0
      : [...companies]
          .sort((a, b) => scoreOf(state, b) - scoreOf(state, a))
          .findIndex((c) => c.id === company.id) + 1;
  const rep = company === undefined ? null : reputationOf(state, company);
  const mine =
    company === undefined
      ? []
      : acceptedContracts(state, filter).filter(
          (k) => k.proposer === company.id || k.counterparty === company.id,
        );
  const value = mine.reduce((sum, k) => sum + contractValue(state, k.obligations), 0);
  const counterparties = new Map<
    CompanyId,
    { value: number; completed: number; defaulted: number; open: number }
  >();
  for (const k of mine) {
    const other = k.proposer === selected ? k.counterparty : k.proposer;
    const t = counterparties.get(other) ?? { value: 0, completed: 0, defaulted: 0, open: 0 };
    t.value += contractValue(state, k.obligations);
    if (k.status.status === 'completed') t.completed += 1;
    else if (k.status.status === 'defaulted') t.defaulted += 1;
    else t.open += 1;
    counterparties.set(other, t);
  }
  return (
    <aside className="card side" aria-label="Selected company">
      <label className="field">
        Company
        <select value={selected ?? ''} onChange={(e) => onSelect(e.target.value as CompanyId)}>
          {selected === null && <option value="">Pick one</option>}
          {companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {company !== undefined && rep !== null && (
        <>
          <div>
            <div style={{ fontSize: 18, fontWeight: 600 }}>{company.name}</div>
            <div className="muted" style={{ fontSize: 13 }}>
              {company.roles.join(', ')} · {driverLabel(state, company.id)} · rank {rank} of{' '}
              {companies.length}
            </div>
          </div>
          <div className="row" style={{ gap: 10 }}>
            <div className="stat">
              <div className="muted">Contracts</div>
              <div className="mono" style={{ fontSize: 20 }}>
                {mine.length}
              </div>
            </div>
            <div className="stat">
              <div className="muted">Defaulted</div>
              <div
                className="mono"
                style={{ fontSize: 20, color: rep.defaulted > 0 ? BAD : undefined }}
              >
                {rep.defaulted}
              </div>
            </div>
            <div className="stat">
              <div className="muted">Value</div>
              <div className="mono" style={{ fontSize: 20 }}>
                {fmt(value)}
              </div>
            </div>
          </div>
          <div>
            <div className="muted" style={{ fontWeight: 500, paddingBottom: 6 }}>
              Counterparties
            </div>
            {[...counterparties.entries()]
              .sort(([, x], [, y]) => y.value - x.value)
              .map(([id, t]) => (
                <div key={id} className="cp-row">
                  <span style={{ flex: 1 }}>{state.companies[id]?.name ?? id}</span>
                  <span className="mono muted">{fmt(t.value)}</span>
                  <Chip kind={t.defaulted > 0 ? 'bad' : t.completed > 0 ? 'ok' : 'neutral'}>
                    {t.defaulted > 0
                      ? `${t.defaulted} defaulted`
                      : t.open > 0
                        ? `${t.open} open`
                        : 'completed'}
                  </Chip>
                </div>
              ))}
            {counterparties.size === 0 && <div className="muted">No accepted contracts.</div>}
          </div>
          <button type="button" className="btn btn-primary" onClick={() => onOpen(company.id)}>
            Open company drill-down
          </button>
        </>
      )}
    </aside>
  );
}
