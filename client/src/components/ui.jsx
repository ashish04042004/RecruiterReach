import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info, Loader2, X, XCircle } from 'lucide-react';

export const cx = (...c) => c.filter(Boolean).join(' ');

const BUTTON = {
  primary: 'bg-indigo-600 text-white hover:bg-indigo-700 disabled:bg-indigo-300',
  secondary: 'bg-white text-slate-700 ring-1 ring-slate-300 hover:bg-slate-50 disabled:text-slate-400',
  danger: 'bg-rose-600 text-white hover:bg-rose-700 disabled:bg-rose-300',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 disabled:bg-emerald-300',
  ghost: 'text-slate-600 hover:bg-slate-100 disabled:text-slate-300',
};

export function Button({ variant = 'secondary', size = 'md', loading, icon: Icon, children, className, ...props }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || loading}
      className={cx(
        'inline-flex shrink-0 items-center justify-center gap-1.5 whitespace-nowrap rounded-md font-medium transition disabled:cursor-not-allowed',
        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3.5 py-2 text-sm',
        BUTTON[variant],
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : Icon ? <Icon className="h-4 w-4" /> : null}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className, padded = true }) {
  return (
    <section className={cx('rounded-lg border border-slate-200 bg-white shadow-sm', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-slate-100 px-4 py-3">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const BADGE = {
  gray: 'bg-slate-100 text-slate-700',
  blue: 'bg-sky-100 text-sky-800',
  indigo: 'bg-indigo-100 text-indigo-800',
  green: 'bg-emerald-100 text-emerald-800',
  yellow: 'bg-amber-100 text-amber-800',
  red: 'bg-rose-100 text-rose-800',
  purple: 'bg-violet-100 text-violet-800',
};

export function Badge({ color = 'gray', children, title, className }) {
  return (
    <span title={title} className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded px-1.5 py-0.5 text-xs font-medium', BADGE[color], className)}>
      {children}
    </span>
  );
}

const STATUS_COLORS = {
  queued: 'gray', generating: 'blue', draft: 'yellow', approved: 'green', skipped: 'gray', rejected: 'red',
  sending: 'blue', sent: 'indigo', failed: 'red', unknown: 'purple',
  new: 'gray', contacted: 'indigo', replied: 'green', bounced: 'red', opted_out: 'red',
  valid: 'green', unchecked: 'gray', invalid: 'red', missing: 'yellow', no_mx: 'red',
  running: 'blue', paused: 'yellow', completed: 'green', cancelled: 'gray', blocked: 'red', limit: 'yellow', pending: 'gray',
  analyzed: 'yellow', committed: 'green', active: 'green', archived: 'gray',
};
const STATUS_LABELS = { draft: 'needs review', no_mx: 'no mail server', opted_out: 'opted out', unchecked: 'unverified' };

export function StatusBadge({ status }) {
  return <Badge color={STATUS_COLORS[status] || 'gray'}>{STATUS_LABELS[status] || status}</Badge>;
}

export function Input({ label, hint, className, ...props }) {
  const input = (
    <input
      {...props}
      className={cx('w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-slate-50', className)}
    />
  );
  if (!label) return input;
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {input}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Textarea({ label, hint, className, ...props }) {
  const el = (
    <textarea
      {...props}
      className={cx('w-full rounded-md border border-slate-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500', className)}
    />
  );
  if (!label) return el;
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {el}
      {hint && <span className="block text-xs text-slate-500">{hint}</span>}
    </label>
  );
}

export function Select({ label, options, className, ...props }) {
  const el = (
    <select
      {...props}
      className={cx('rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm shadow-sm focus:border-indigo-500 focus:outline-none', label && 'w-full', className)}
    >
      {options.map((o) => (
        <option key={String(o.value)} value={o.value ?? ''}>
          {o.label}
        </option>
      ))}
    </select>
  );
  if (!label) return el;
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-slate-600">{label}</span>
      {el}
    </label>
  );
}

export function Checkbox({ label, checked, onChange, disabled }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-sm', disabled ? 'text-slate-400' : 'text-slate-700')}>
      <input type="checkbox" className="h-4 w-4 rounded border-slate-300 text-indigo-600" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Spinner({ label }) {
  return (
    <div className="flex items-center gap-2 p-6 text-sm text-slate-500">
      <Loader2 className="h-4 w-4 animate-spin" /> {label || 'Loading…'}
    </div>
  );
}

export function Empty({ icon: Icon = Info, title, children }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
      <Icon className="h-8 w-8 text-slate-300" />
      <p className="font-medium text-slate-700">{title}</p>
      {children && <div className="max-w-md text-sm text-slate-500">{children}</div>}
    </div>
  );
}

export function Alert({ kind = 'info', title, children, className }) {
  const styles = {
    info: ['border-sky-200 bg-sky-50 text-sky-900', Info],
    warning: ['border-amber-200 bg-amber-50 text-amber-900', AlertTriangle],
    error: ['border-rose-200 bg-rose-50 text-rose-900', XCircle],
    success: ['border-emerald-200 bg-emerald-50 text-emerald-900', CheckCircle2],
  }[kind];
  const Icon = styles[1];
  return (
    <div className={cx('flex gap-2.5 rounded-md border px-3 py-2.5 text-sm', styles[0], className)}>
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 space-y-1">
        {title && <p className="font-medium">{title}</p>}
        {children && <div>{children}</div>}
      </div>
    </div>
  );
}

export function ErrorAlert({ error }) {
  if (!error) return null;
  return (
    <Alert kind="error" title={error.message}>
      {Array.isArray(error.details?.problems) && (
        <ul className="list-disc pl-4">
          {error.details.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
    </Alert>
  );
}

export function PageHeader({ title, subtitle, actions }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, accent }) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className={cx('mt-1 text-2xl font-semibold', accent || 'text-slate-900')}>{value}</p>
      {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 pt-16" onMouseDown={onClose}>
      <div className={cx('w-full rounded-lg bg-white shadow-xl', wide ? 'max-w-4xl' : 'max-w-lg')} onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-100 px-5 py-3">{footer}</footer>}
      </div>
    </div>
  );
}

export function Drawer({ open, onClose, title, children }) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-xl" onMouseDown={(e) => e.stopPropagation()}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h3 className="font-semibold">{title}</h3>
          <button type="button" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100">
            <X className="h-4 w-4" />
          </button>
        </header>
        <div className="scroll-thin flex-1 overflow-y-auto p-5">{children}</div>
      </div>
    </div>
  );
}

export function Progress({ value, total, label }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-slate-600">
        <span>{label}</span>
        <span>
          {value}/{total}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded bg-slate-200">
        <div className="h-full bg-indigo-500 transition-all" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between px-4 py-2 text-sm text-slate-600">
      <span>
        {total === 0 ? 'No results' : `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total}`}
      </span>
      <div className="flex gap-1">
        <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </Button>
        <Button size="sm" variant="ghost" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Next
        </Button>
      </div>
    </div>
  );
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const fmtDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');

// ---------- Toasts ----------

const ToastContext = createContext(() => {});

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const push = useCallback((message, kind = 'success') => {
    const id = Math.random().toString(36).slice(2);
    setToasts((t) => [...t, { id, message, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="fixed bottom-4 right-4 z-50 flex w-96 flex-col gap-2">
        {toasts.map((t) => (
          <Alert key={t.id} kind={t.kind} className="shadow-lg">
            {t.message}
          </Alert>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
