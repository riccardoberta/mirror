import type { ReactNode } from 'react';
import type { Tone } from './format';

export function Toggle({ on, onChange, disabled, label }: { on: boolean; onChange: (v: boolean) => void; disabled?: boolean; label: string }) {
  return (
    <button
      type="button"
      className={`toggle${on ? ' on' : ''}`}
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!on)}
    />
  );
}

export function Dot({ tone }: { tone: Tone }) {
  return <span className={`dot${tone === 'neutral' ? '' : ` ${tone}`}`} />;
}

export function Banner({ tone, glyph, children }: { tone: 'warn' | 'err' | 'info'; glyph: string; children: ReactNode }) {
  return (
    <div className={`banner ${tone}`}>
      <div className="glyph" aria-hidden>
        {glyph}
      </div>
      <div className="grow">{children}</div>
    </div>
  );
}

export function Sheet({ title, onClose, children, footer }: { title: string; onClose: () => void; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="sheet" role="dialog" aria-label={title}>
        <header>
          <h3>{title}</h3>
          <button className="btn icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <div className="sheet-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </div>
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint && <span className="faint small">{hint}</span>}
    </div>
  );
}
