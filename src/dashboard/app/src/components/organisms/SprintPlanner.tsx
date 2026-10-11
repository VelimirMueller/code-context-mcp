import React, { useState, useEffect } from 'react';
import { usePlanningStore } from '@/stores/planningStore';
import type { Ticket } from '@/types';

const VELOCITY_WARN = 19;

interface SprintPlannerProps {
  onClose: () => void;
}

type Step = 1 | 2 | 3 | 'success';

interface Step1Data {
  name: string;
  goal: string;
  startDate: string;
  endDate: string;
}

function TicketRow({
  ticket,
  checked,
  onChange,
}: {
  ticket: Ticket;
  checked: boolean;
  onChange: (id: number, checked: boolean) => void;
}) {
  const pts = ticket.story_points ?? 0;
  const priorityColors: Record<string, string> = {
    critical: 'var(--red)',
    high: 'var(--orange)',
    medium: 'var(--accent2)',
    low: 'var(--text3)',
  };
  const pColor = priorityColors[ticket.priority] ?? 'var(--text3)';

  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '9px 14px',
        cursor: 'pointer',
        borderBottom: '1px solid var(--border)',
        background: checked ? 'rgba(99,102,241,.04)' : 'transparent',
        transition: 'background .15s',
      }}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(ticket.id, e.target.checked)}
        style={{ accentColor: 'var(--accent)', width: 15, height: 15, cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {ticket.title}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
          {ticket.ticket_ref && (
            <span style={{ fontFamily: 'var(--mono)', fontSize: 11, color: 'var(--text3)' }}>{ticket.ticket_ref}</span>
          )}
          <span style={{ fontSize: 11, color: pColor, fontWeight: 500, textTransform: 'capitalize' }}>{ticket.priority}</span>
        </div>
      </div>
      <span style={{ fontFamily: 'var(--mono)', fontSize: 12, color: pts > 0 ? 'var(--accent2)' : 'var(--text3)', fontWeight: 600, flexShrink: 0 }}>
        {pts > 0 ? `${pts}pt` : '—'}
      </span>
    </label>
  );
}

export function SprintPlanner({ onClose }: SprintPlannerProps) {
  const fetchBacklog = usePlanningStore((s) => s.fetchBacklog);
  const backlog = usePlanningStore((s) => s.backlog);
  const loadingBacklog = usePlanningStore((s) => s.loading.backlog);
  const planSprint = usePlanningStore((s) => s.planSprint);

  const [step, setStep] = useState<Step>(1);
  const [step1, setStep1] = useState<Step1Data>({ name: '', goal: '', startDate: '', endDate: '' });
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdId, setCreatedId] = useState<number | null>(null);

  useEffect(() => {
    if (step === 2) {
      fetchBacklog();
    }
  }, [step, fetchBacklog]);

  const totalPoints = backlog
    .filter((t) => selectedIds.has(t.id))
    .reduce((sum, t) => sum + (t.story_points ?? 0), 0);

  const overVelocity = totalPoints > VELOCITY_WARN;

  const toggleTicket = (id: number, checked: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const handlePlan = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await planSprint({
        name: step1.name.trim(),
        goal: step1.goal.trim() || undefined,
        startDate: step1.startDate,
        endDate: step1.endDate,
        targetVelocity: totalPoints,
        ticketIds: Array.from(selectedIds),
      });
      setCreatedId(result.id);
      setStep('success');
    } catch {
      setError('Failed to create sprint. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const inputStyle: React.CSSProperties = {
    background: 'var(--surface3)',
    border: '1px solid var(--border2)',
    borderRadius: 8,
    color: 'var(--text)',
    fontSize: 13,
    padding: '9px 12px',
    fontFamily: 'var(--font)',
    width: '100%',
    outline: 'none',
  };

  const btnPrimary: React.CSSProperties = {
    background: 'var(--pill-bg)',
    color: 'var(--pill-fg)',
    border: 'none',
    borderRadius: 'var(--radius-pill)',
    padding: '9px 22px',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'var(--font)',
  };

  const btnSecondary: React.CSSProperties = {
    background: 'none',
    border: '1px solid var(--border2)',
    borderRadius: 8,
    padding: '9px 16px',
    fontSize: 13,
    color: 'var(--text2)',
    cursor: 'pointer',
    fontFamily: 'var(--font)',
  };

  const stepIndicator = (current: number) => (
    <div style={{ display: 'flex', gap: 6, marginBottom: 20 }}>
      {[1, 2, 3].map((n) => (
        <div
          key={n}
          style={{
            width: 28,
            height: 28,
            borderRadius: '50%',
            background: n === current ? 'var(--accent)' : n < current ? 'rgba(99,102,241,.3)' : 'var(--surface3)',
            border: `2px solid ${n === current ? 'var(--accent)' : n < current ? 'var(--accent)' : 'var(--border2)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 12,
            fontWeight: 700,
            fontFamily: 'var(--mono)',
            color: n === current ? '#000' : n < current ? 'var(--accent2)' : 'var(--text3)',
            transition: 'all .2s',
          }}
        >
          {n}
        </div>
      ))}
    </div>
  );

  const renderStep1 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stepIndicator(1)}
      <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)', marginBottom: 4 }}>Sprint Details</h3>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Sprint name *</label>
        <input
          style={inputStyle}
          placeholder="e.g. Sprint 10"
          value={step1.name}
          onChange={(e) => setStep1((s) => ({ ...s, name: e.target.value }))}
          required
        />
      </div>
      <div>
        <label style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Goal</label>
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
          placeholder="What will this sprint achieve?"
          value={step1.goal}
          onChange={(e) => setStep1((s) => ({ ...s, goal: e.target.value }))}
        />
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>Start date *</label>
          <input
            type="date"
            style={inputStyle}
            value={step1.startDate}
            onChange={(e) => setStep1((s) => ({ ...s, startDate: e.target.value }))}
            required
          />
        </div>
        <div>
          <label style={{ fontSize: 12, color: 'var(--text3)', display: 'block', marginBottom: 4 }}>End date *</label>
          <input
            type="date"
            style={inputStyle}
            value={step1.endDate}
            onChange={(e) => setStep1((s) => ({ ...s, endDate: e.target.value }))}
            required
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button
          style={{ ...btnPrimary, opacity: step1.name.trim() ? 1 : 0.5 }}
          onClick={() => { if (step1.name.trim()) setStep(2); }}
          disabled={!step1.name.trim()}
        >
          Next: Select Tickets →
        </button>
        <button style={btnSecondary} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );

  const renderStep2 = () => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {stepIndicator(2)}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Select Backlog Tickets</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: overVelocity ? 'var(--orange)' : 'var(--accent2)' }}>
            {totalPoints}pt
          </span>
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>/ {VELOCITY_WARN}pt target</span>
        </div>
      </div>

      {overVelocity && (
        <div style={{
          background: 'rgba(251,191,36,.10)',
          border: '1px solid rgba(251,191,36,.25)',
          borderRadius: 8,
          padding: '9px 14px',
          fontSize: 13,
          color: 'var(--orange)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}>
          <span>⚠</span>
          <span>Selected tickets exceed the {VELOCITY_WARN}pt velocity target ({totalPoints}pt selected). Consider reducing scope.</span>
        </div>
      )}

      <div
        style={{
          background: 'var(--surface3)',
          border: '1px solid var(--border)',
          borderRadius: 10,
          overflow: 'hidden',
          maxHeight: 320,
          overflowY: 'auto',
        }}
      >
        {loadingBacklog && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text3)', fontSize: 13 }}>
            Loading backlog…
          </div>
        )}
        {!loadingBacklog && backlog.length === 0 && (
          <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text3)', fontSize: 13 }}>
            No backlog tickets available.
          </div>
        )}
        {backlog.map((ticket) => (
          <TicketRow
            key={ticket.id}
            ticket={ticket}
            checked={selectedIds.has(ticket.id)}
            onChange={toggleTicket}
          />
        ))}
      </div>

      <div style={{ fontSize: 12, color: 'var(--text3)' }}>
        {selectedIds.size} ticket{selectedIds.size !== 1 ? 's' : ''} selected
      </div>

      <div style={{ display: 'flex', gap: 8 }}>
        <button style={btnPrimary} onClick={() => setStep(3)}>
          Next: Confirm →
        </button>
        <button style={btnSecondary} onClick={() => setStep(1)}>← Back</button>
        <button style={btnSecondary} onClick={onClose}>Cancel</button>
      </div>
    </div>
  );

  const renderStep3 = () => {
    const selected = backlog.filter((t) => selectedIds.has(t.id));
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {stepIndicator(3)}
        <h3 style={{ fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>Confirm Sprint Plan</h3>

        <div style={{ background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text3)', fontSize: 13, minWidth: 80 }}>Name:</span>
            <span style={{ color: 'var(--text)', fontSize: 13, fontWeight: 600 }}>{step1.name}</span>
          </div>
          {step1.goal && (
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text3)', fontSize: 13, minWidth: 80 }}>Goal:</span>
              <span style={{ color: 'var(--text2)', fontSize: 13 }}>{step1.goal}</span>
            </div>
          )}
          {step1.startDate && (
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--text3)', fontSize: 13, minWidth: 80 }}>Dates:</span>
              <span style={{ fontFamily: 'var(--mono)', color: 'var(--text2)', fontSize: 13 }}>{step1.startDate} → {step1.endDate}</span>
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text3)', fontSize: 13, minWidth: 80 }}>Tickets:</span>
            <span style={{ fontFamily: 'var(--mono)', color: 'var(--accent2)', fontSize: 13, fontWeight: 600 }}>{selected.length}</span>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <span style={{ color: 'var(--text3)', fontSize: 13, minWidth: 80 }}>Velocity:</span>
            <span style={{ fontFamily: 'var(--mono)', fontSize: 13, fontWeight: 700, color: overVelocity ? 'var(--orange)' : 'var(--accent2)' }}>
              {totalPoints}pt {overVelocity && `(⚠ over ${VELOCITY_WARN}pt target)`}
            </span>
          </div>
        </div>

        {selected.length > 0 && (
          <div style={{ maxHeight: 180, overflowY: 'auto', background: 'var(--surface3)', border: '1px solid var(--border)', borderRadius: 8 }}>
            {selected.map((t) => (
              <div key={t.id} style={{ padding: '7px 14px', borderBottom: '1px solid var(--border)', fontSize: 12, color: 'var(--text2)', display: 'flex', justifyContent: 'space-between' }}>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{t.title}</span>
                <span style={{ fontFamily: 'var(--mono)', color: 'var(--text3)', flexShrink: 0, marginLeft: 8 }}>{t.story_points ?? 0}pt</span>
              </div>
            ))}
          </div>
        )}

        {error && <div style={{ color: 'var(--red)', fontSize: 12 }}>{error}</div>}

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            style={{ ...btnPrimary, opacity: busy ? 0.6 : 1 }}
            onClick={handlePlan}
            disabled={busy}
          >
            {busy ? 'Creating…' : 'Create Sprint'}
          </button>
          <button style={btnSecondary} onClick={() => setStep(2)} disabled={busy}>← Back</button>
          <button style={btnSecondary} onClick={onClose} disabled={busy}>Cancel</button>
        </div>
      </div>
    );
  };

  const renderSuccess = () => (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16, padding: '20px 0' }}>
      <div style={{ width: 56, height: 56, borderRadius: '50%', background: 'rgba(99,102,241,.15)', border: '2px solid var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24 }}>
        ✓
      </div>
      <h3 style={{ fontSize: 16, fontWeight: 700, color: 'var(--text)' }}>Sprint Created!</h3>
      {createdId && (
        <div style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--text3)' }}>
          Sprint ID: <span style={{ color: 'var(--accent2)', fontWeight: 600 }}>#{createdId}</span>
        </div>
      )}
      <p style={{ fontSize: 13, color: 'var(--text2)', textAlign: 'center' }}>
        <strong style={{ color: 'var(--text)' }}>{step1.name}</strong> has been planned with {selectedIds.size} ticket{selectedIds.size !== 1 ? 's' : ''} and {totalPoints}pt committed.
      </p>
      <button style={btnPrimary} onClick={onClose}>Done</button>
    </div>
  );

  return (
    // Backdrop
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.60)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
        padding: 24,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      {/* Card */}
      <div
        style={{
          background: 'var(--surface)',
          border: '1px solid var(--border2)',
          borderRadius: 'var(--radius-lg)',
          padding: '24px 28px',
          width: '100%',
          maxWidth: 520,
          maxHeight: '90vh',
          overflowY: 'auto',
          boxShadow: '0 24px 64px rgba(0,0,0,.6)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <h2 style={{ fontSize: 17, fontWeight: 700, color: 'var(--text)' }}>Plan Sprint</h2>
          <button
            onClick={onClose}
            style={{ background: 'none', border: 'none', color: 'var(--text3)', cursor: 'pointer', fontSize: 18, lineHeight: 1, padding: 4 }}
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {step === 1 && renderStep1()}
        {step === 2 && renderStep2()}
        {step === 3 && renderStep3()}
        {step === 'success' && renderSuccess()}
      </div>
    </div>
  );
}
