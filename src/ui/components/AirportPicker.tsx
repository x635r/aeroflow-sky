import { useEffect, useMemo, useRef, useState } from 'react';
import type { Airport } from '../../state/store';

type Props = {
  role: 'from' | 'to';
  value: Airport | null;
  airports: Airport[];
  onChange: (a: Airport | null) => void;
};

/** 模糊搜索：IATA / ICAO / 城市 / 机场名，支持中文城市名首字匹配 */
function score(a: Airport, q: string): number {
  if (!q) return a.degree ?? 0;
  const s = q.toLowerCase().trim();
  const iata = a.iata.toLowerCase();
  const icao = a.icao.toLowerCase();
  const city = (a.city || '').toLowerCase();
  const name = (a.name || '').toLowerCase();

  if (iata === s || icao === s) return 1e6;
  if (iata.startsWith(s)) return 5e5 + (a.degree ?? 0);
  if (city.startsWith(s)) return 4e5 + (a.degree ?? 0);
  if (name.startsWith(s)) return 3e5 + (a.degree ?? 0);
  if (city.includes(s)) return 2e5 + (a.degree ?? 0);
  if (name.includes(s)) return 1e5 + (a.degree ?? 0);
  if (iata.includes(s)) return 5e4 + (a.degree ?? 0);
  return 0;
}

export function AirportPicker({ role, value, airports, onChange }: Props) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const matches = useMemo(() => {
    const q = query.trim();
    const pool = q ? airports : airports.slice(0, 40);
    return pool
      .map((a) => ({ a, s: score(a, q) }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 30)
      .map((x) => x.a);
  }, [airports, query]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  const commit = (a: Airport) => {
    onChange(a);
    setQuery('');
    setOpen(false);
    inputRef.current?.blur();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(matches.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      if (open && matches[active]) commit(matches[active]);
    } else if (e.key === 'Escape') {
      setOpen(false);
      inputRef.current?.blur();
    }
  };

  const display = value ? value.iata : '';

  return (
    <div className="airport-field" ref={wrapRef}>
      <div className="airport-badge" data-role={role}>
        {role === 'from' ? '起' : '降'}
      </div>
      <input
        ref={inputRef}
        value={open ? query : display}
        placeholder={role === 'from' ? '出发机场 · 如 JFK' : '到达机场 · 如 LHR'}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => {
          setQuery('');
          setOpen(true);
        }}
        onKeyDown={onKey}
        autoComplete="off"
        spellCheck={false}
        aria-label={role === 'from' ? '出发机场' : '到达机场'}
      />
      {value && !open && <div className="airport-meta">{value.city}</div>}

      {open && matches.length === 0 && query.trim() !== '' && (
        <div className="airport-suggest" role="status">
          <div className="airport-empty">未找到「{query.trim()}」</div>
        </div>
      )}

      {open && matches.length > 0 && (
        <div className="airport-suggest" role="listbox">
          {matches.map((a, i) => (
            <button
              key={a.iata}
              className="airport-option"
              data-active={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => commit(a)}
              role="option"
              aria-selected={i === active}
              type="button"
            >
              <span className="code">{a.iata}</span>
              <span className="name">
                {a.city} · {a.name}
              </span>
              <span className="sub">{a.country}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
