import React, { useState } from 'react';

const PRESET_COLORS = ['#60a5fa', '#10b981', '#a5b4fc', '#fbbf24', '#ec4899', '#f87171', '#06b6d4', '#84cc16'];

export interface InlineEditField {
  name: string;
  label?: string;
  type: 'text' | 'textarea' | 'select' | 'color-picker' | 'date';
  required?: boolean;
  placeholder?: string;
  options?: { value: string; label: string }[];
  defaultValue?: string;
}

interface InlineEditFormProps {
  fields: InlineEditField[];
  onSubmit: (values: Record<string, string>) => void | Promise<void>;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  submitLabel?: string;
}

const inputStyle: React.CSSProperties = {
  background: 'var(--surface2)',
  border: '1px solid var(--border2)',
  borderRadius: 8,
  color: 'var(--text)',
  fontSize: 13,
  padding: '8px 12px',
  fontFamily: 'var(--font)',
  width: '100%',
  outline: 'none',
};

export function InlineEditForm({ fields, onSubmit, onCancel, busy = false, error = null, submitLabel = 'Save' }: InlineEditFormProps) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const initial: Record<string, string> = {};
    for (const f of fields) {
      initial[f.name] = f.defaultValue ?? '';
    }
    return initial;
  });

  const setValue = (name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit(values);
  };

  return (
    <form
      onSubmit={handleSubmit}
      style={{
        background: 'var(--surface2)',
        border: '1px solid var(--border2)',
        borderRadius: 'var(--radius)',
        padding: '16px 20px',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      }}
    >
      {fields.map((field) => {
        if (field.type === 'textarea') {
          return (
            <textarea
              key={field.name}
              style={{ ...inputStyle, resize: 'vertical', minHeight: 70 }}
              placeholder={field.placeholder ?? field.label}
              value={values[field.name] ?? ''}
              onChange={(e) => setValue(field.name, e.target.value)}
              required={field.required}
              disabled={busy}
            />
          );
        }

        if (field.type === 'select') {
          return (
            <select
              key={field.name}
              style={inputStyle}
              value={values[field.name] ?? ''}
              onChange={(e) => setValue(field.name, e.target.value)}
              required={field.required}
              disabled={busy}
            >
              <option value="">{field.placeholder ?? `Select ${field.label ?? field.name}`}</option>
              {(field.options ?? []).map((opt) => (
                <option key={opt.value} value={opt.value}>{opt.label}</option>
              ))}
            </select>
          );
        }

        if (field.type === 'color-picker') {
          return (
            <div key={field.name} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text3)', fontWeight: 600 }}>
                {field.label ?? 'Color'}:
              </span>
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setValue(field.name, c)}
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    background: c,
                    border: values[field.name] === c ? '2px solid var(--text)' : '2px solid transparent',
                    cursor: 'pointer',
                    padding: 0,
                    outline: 'none',
                  }}
                />
              ))}
            </div>
          );
        }

        if (field.type === 'date') {
          return (
            <input
              key={field.name}
              type="date"
              style={inputStyle}
              value={values[field.name] ?? ''}
              onChange={(e) => setValue(field.name, e.target.value)}
              required={field.required}
              disabled={busy}
            />
          );
        }

        // Default: text
        return (
          <input
            key={field.name}
            type="text"
            style={inputStyle}
            placeholder={field.placeholder ?? field.label}
            value={values[field.name] ?? ''}
            onChange={(e) => setValue(field.name, e.target.value)}
            required={field.required}
            disabled={busy}
          />
        );
      })}

      {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

      <div style={{ display: 'flex', gap: 8 }}>
        <button
          type="submit"
          disabled={busy}
          style={{
            background: busy ? 'var(--surface3)' : 'var(--accent)',
            color: busy ? 'var(--text3)' : '#000',
            border: 'none',
            borderRadius: 8,
            padding: '8px 20px',
            fontSize: 13,
            fontWeight: 600,
            cursor: busy ? 'not-allowed' : 'pointer',
            fontFamily: 'var(--font)',
          }}
        >
          {busy ? 'Saving...' : submitLabel}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          style={{
            background: 'none',
            border: '1px solid var(--border2)',
            borderRadius: 8,
            padding: '8px 16px',
            fontSize: 13,
            color: 'var(--text2)',
            cursor: 'pointer',
            fontFamily: 'var(--font)',
          }}
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
