import React from 'react';
import { Player } from '@remotion/player';
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
  Sequence,
} from 'remotion';

/* ─── Constants ────────────────────────────────────────────────────────────── */

const DARK_BG = '#0a0a0b';
const W = '#ffffff';
const W2 = 'rgba(255,255,255,0.6)';
const ACCENT = '#818cf8';
const BLUE = '#60a5fa';
const PURPLE = '#a5b4fc';
const PINK = '#ec4899';
const ORANGE = '#fbbf24';

const FPS = 30;
// Scene durations in frames (30fps)
const S1 = 210; // What it does — slow typewriter
const S2 = 180; // Benefits
const S3 = 180; // Roadmap
const S4 = 150; // Integrations
const S5 = 90;  // Closing
const TOTAL = S1 + S2 + S3 + S4 + S5; // 810 frames = 27s

/* ─── Helpers ──────────────────────────────────────────────────────────────── */

const clamp = { extrapolateLeft: 'clamp' as const, extrapolateRight: 'clamp' as const };

const FadeIn: React.FC<{ delay: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ delay, children, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const opacity = spring({ frame: frame - delay, fps, config: { damping: 20 } });
  const y = interpolate(opacity, [0, 1], [30, 0]);
  return <div style={{ opacity, transform: `translateY(${y}px)`, ...style }}>{children}</div>;
};

const Typewriter: React.FC<{ text: string; startFrame: number; speed?: number; style?: React.CSSProperties }> = ({
  text, startFrame, speed = 1.2, style,
}) => {
  const frame = useCurrentFrame();
  const elapsed = Math.max(0, frame - startFrame);
  const charsToShow = Math.floor(elapsed * speed);
  const visible = text.slice(0, charsToShow);
  const done = charsToShow >= text.length;
  const cursorOpacity = done ? 0 : Math.sin(frame * 0.4) * 0.5 + 0.5;

  return (
    <div style={style}>
      {visible}
      {!done && <span style={{ opacity: cursorOpacity, color: ACCENT }}>|</span>}
    </div>
  );
};

/* ─── Scene 1: What This Tool Does ────────────────────────────────────────── */

const WhatItDoesScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleScale = spring({ frame, fps, from: 0.85, to: 1, config: { damping: 18 } });
  const titleOpacity = interpolate(frame, [0, 25], [0, 1], clamp);

  const features = [
    { icon: '>', text: 'Sprint planning, tickets & retros via MCP tools', color: BLUE },
    { icon: '>', text: '16 AI agents — PO, SM, devs, QA, security, architect', color: PURPLE },
    { icon: '>', text: 'Real-time dashboard with code explorer & Gantt charts', color: PINK },
    { icon: '>', text: 'Extensible via MCP — onboarding and refinement lifecycle', color: ORANGE },
  ];

  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '60px 80px' }}>
      {/* Badge */}
      <FadeIn delay={0} style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', fontFamily: 'monospace' }}>
          Model Context Protocol
        </div>
      </FadeIn>

      {/* Title */}
      <div style={{
        opacity: titleOpacity, transform: `scale(${titleScale})`,
        fontSize: 56, fontWeight: 800, color: W, textAlign: 'center', fontFamily: 'sans-serif',
        marginBottom: 16, lineHeight: 1.15,
      }}>
        Code Context <span style={{ color: ACCENT }}>MCP</span>
      </div>

      {/* Subtitle typewriter */}
      <Typewriter
        text="Your AI-powered virtual IT department — sprint planning, project management, and development workflows, all through a single MCP server."
        startFrame={40}
        speed={1.0}
        style={{ fontSize: 22, color: W2, maxWidth: 800, textAlign: 'center', fontFamily: 'sans-serif', lineHeight: 1.7, marginBottom: 50 }}
      />

      {/* Feature list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 750 }}>
        {features.map((f, i) => (
          <FadeIn key={i} delay={90 + i * 18}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8,
                backgroundColor: `${f.color}20`, border: `1px solid ${f.color}40`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 16, color: f.color, fontFamily: 'monospace', fontWeight: 700,
              }}>{f.icon}</div>
              <span style={{ fontSize: 20, color: W, fontFamily: 'sans-serif', fontWeight: 500 }}>{f.text}</span>
            </div>
          </FadeIn>
        ))}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 2: Benefits ───────────────────────────────────────────────────── */

const BenefitsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const benefits = [
    {
      title: 'Controlled AI Process',
      desc: 'Structured sprints, not chaotic prompting. Every task is planned, estimated, and tracked.',
      icon: '{}',
      color: BLUE,
    },
    {
      title: 'Deep Insights',
      desc: 'Velocity trends, burndown charts, retro findings. Know exactly where your project stands.',
      icon: '//',
      color: PURPLE,
    },
    {
      title: 'Token Savings',
      desc: 'Agents share context through MCP — no repeated file reads, no wasted tokens on rediscovery.',
      icon: '$',
      color: ACCENT,
    },
    {
      title: 'Full Audit Trail',
      desc: 'Every decision, every ticket, every sprint — logged and queryable. Nothing gets lost.',
      icon: '#',
      color: PINK,
    },
  ];

  const headingOpacity = spring({ frame, fps, config: { damping: 20 } });

  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '50px 70px' }}>
      <div style={{ opacity: headingOpacity, fontSize: 14, fontWeight: 600, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', fontFamily: 'monospace', marginBottom: 14 }}>
        Why It Matters
      </div>
      <div style={{ opacity: headingOpacity, fontSize: 48, fontWeight: 800, color: W, fontFamily: 'sans-serif', marginBottom: 50, textAlign: 'center' }}>
        Ship faster. Ship <span style={{ color: ACCENT }}>smarter</span>.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 28, maxWidth: 950, width: '100%' }}>
        {benefits.map((b, i) => {
          const delay = 30 + i * 20;
          const progress = spring({ frame: frame - delay, fps, config: { damping: 18 } });
          const y = interpolate(progress, [0, 1], [50, 0]);
          return (
            <div key={i} style={{
              opacity: progress, transform: `translateY(${y}px)`,
              backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 16, padding: '28px 24px',
              display: 'flex', flexDirection: 'column', gap: 10,
            }}>
              <div style={{
                width: 44, height: 44, borderRadius: 10,
                backgroundColor: `${b.color}15`, border: `1px solid ${b.color}30`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, color: b.color, fontFamily: 'monospace', fontWeight: 700,
              }}>{b.icon}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: W, fontFamily: 'sans-serif' }}>{b.title}</div>
              <div style={{ fontSize: 16, color: W2, fontFamily: 'sans-serif', lineHeight: 1.6 }}>{b.desc}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 3: Roadmap ────────────────────────────────────────────────────── */

const RoadmapScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const phases = [
    { label: 'Foundation', detail: 'MCP server, scrum DB, dashboard, agents', status: 'shipped', color: ACCENT },
    { label: 'Scale', detail: 'Gantt, sprint insights, code explorer', status: 'shipped', color: ACCENT },
    { label: 'Platform', detail: 'Marketing, CHANGELOG, Remotion animations', status: 'shipped', color: ACCENT },
    { label: 'Publish', detail: 'npm registry, one-command install for any project', status: 'next', color: ORANGE },
    { label: 'Ecosystem', detail: 'Multi-project support, GitHub/GitLab sync', status: 'planned', color: BLUE },
    { label: 'Intelligence', detail: 'Predictive planning, auto-refinement, AI retrospectives', status: 'planned', color: PURPLE },
  ];

  const headingOpacity = spring({ frame, fps, config: { damping: 20 } });

  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '50px 80px' }}>
      <div style={{ opacity: headingOpacity, fontSize: 14, fontWeight: 600, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', fontFamily: 'monospace', marginBottom: 14 }}>
        Roadmap
      </div>
      <div style={{ opacity: headingOpacity, fontSize: 48, fontWeight: 800, color: W, fontFamily: 'sans-serif', marginBottom: 50, textAlign: 'center' }}>
        Where we're <span style={{ color: ACCENT }}>going</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 800, width: '100%' }}>
        {phases.map((p, i) => {
          const delay = 25 + i * 15;
          const progress = spring({ frame: frame - delay, fps, config: { damping: 18 } });
          const tx = interpolate(progress, [0, 1], [-600, 0]);
          return (
            <div key={i} style={{
              opacity: progress, transform: `translateX(${tx}px)`,
              display: 'flex', alignItems: 'center', gap: 20,
              backgroundColor: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.06)',
              borderRadius: 12, padding: '18px 24px',
            }}>
              {/* Timeline dot + line */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: 20, flexShrink: 0 }}>
                <div style={{
                  width: 14, height: 14, borderRadius: '50%',
                  backgroundColor: p.status === 'shipped' ? p.color : 'transparent',
                  border: `2px solid ${p.color}`,
                }} />
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: W, fontFamily: 'sans-serif' }}>{p.label}</div>
                <div style={{ fontSize: 15, color: W2, fontFamily: 'sans-serif', marginTop: 2 }}>{p.detail}</div>
              </div>
              <div style={{
                fontSize: 12, fontWeight: 700, fontFamily: 'monospace', letterSpacing: 1,
                color: p.status === 'shipped' ? ACCENT : p.status === 'next' ? ORANGE : BLUE,
                textTransform: 'uppercase',
                padding: '4px 12px', borderRadius: 6,
                backgroundColor: p.status === 'shipped' ? `${ACCENT}15` : p.status === 'next' ? `${ORANGE}15` : `${BLUE}15`,
              }}>
                {p.status}
              </div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 4: Integrations ───────────────────────────────────────────────── */

const IntegrationsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const integrations = [
    { name: 'Notion', desc: 'Docs & knowledge base', color: W },
    { name: 'Airtable', desc: 'Custom workflows', color: '#18BFFF' },
    { name: 'GitHub', desc: 'PRs, issues, actions', color: W },
    { name: 'GitLab', desc: 'Merge requests & CI', color: '#FC6D26' },
    { name: 'Slack', desc: 'Notifications & updates', color: '#E01E5A' },
  ];

  const headingOpacity = spring({ frame, fps, config: { damping: 20 } });

  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '50px 70px' }}>
      <div style={{ opacity: headingOpacity, fontSize: 14, fontWeight: 600, color: ACCENT, letterSpacing: 3, textTransform: 'uppercase', fontFamily: 'monospace', marginBottom: 14 }}>
        Ecosystem
      </div>
      <div style={{ opacity: headingOpacity, fontSize: 44, fontWeight: 800, color: W, fontFamily: 'sans-serif', marginBottom: 12, textAlign: 'center' }}>
        Connect your <span style={{ color: ACCENT }}>tools</span>
      </div>
      <div style={{ opacity: headingOpacity, fontSize: 20, color: W2, fontFamily: 'sans-serif', marginBottom: 50, textAlign: 'center', maxWidth: 650 }}>
        Plug into the tools you already use. One MCP server, unlimited integrations.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 20, maxWidth: 750, width: '100%' }}>
        {integrations.map((ig, i) => {
          const delay = 20 + i * 12;
          const scale = spring({ frame: frame - delay, fps, from: 0.7, to: 1, config: { damping: 16 } });
          const opacity = interpolate(frame, [delay, delay + 15], [0, 1], clamp);
          return (
            <div key={i} style={{
              opacity, transform: `scale(${scale})`,
              backgroundColor: 'rgba(255,255,255,0.04)', border: '1px solid rgba(255,255,255,0.08)',
              borderRadius: 14, padding: '24px 20px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, textAlign: 'center',
            }}>
              <div style={{
                width: 48, height: 48, borderRadius: 12,
                backgroundColor: `${ig.color}12`, border: `1px solid ${ig.color}25`,
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 18, fontWeight: 800, color: ig.color, fontFamily: 'sans-serif',
              }}>
                {ig.name[0]}
              </div>
              <div style={{ fontSize: 19, fontWeight: 700, color: W, fontFamily: 'sans-serif' }}>{ig.name}</div>
              <div style={{ fontSize: 14, color: W2, fontFamily: 'sans-serif' }}>{ig.desc}</div>
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};

/* ─── Scene 5: Closing ────────────────────────────────────────────────────── */

const ClosingScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const titleProgress = spring({ frame, fps, config: { damping: 16 } });
  const cmdDelay = 30;
  const cmdProgress = spring({ frame: frame - cmdDelay, fps, config: { damping: 18 } });

  return (
    <AbsoluteFill style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 30 }}>
      <div style={{
        opacity: titleProgress, transform: `scale(${interpolate(titleProgress, [0, 1], [0.9, 1])})`,
        fontSize: 50, fontWeight: 800, color: W, textAlign: 'center', fontFamily: 'sans-serif', lineHeight: 1.2,
      }}>
        One package.<br /><span style={{ color: ACCENT }}>Infinite structure.</span>
      </div>
      <div style={{
        opacity: cmdProgress,
        backgroundColor: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 12, padding: '16px 36px',
        fontSize: 22, fontFamily: 'monospace', color: ACCENT, fontWeight: 600,
      }}>
        npx vlm-code-context-mcp
      </div>
      <div style={{
        opacity: interpolate(frame, [50, 70], [0, 1], clamp),
        fontSize: 16, color: W2, fontFamily: 'sans-serif',
      }}>
        Built by AI. Shipped by AI. Managed by AI.
      </div>
    </AbsoluteFill>
  );
};

/* ─── Composition ──────────────────────────────────────────────────────────── */

const VisionVideoComp: React.FC = () => {
  let offset = 0;
  return (
    <AbsoluteFill style={{ backgroundColor: DARK_BG }}>
      <Sequence from={offset} durationInFrames={S1}><WhatItDoesScene /></Sequence>
      <Sequence from={(offset += S1)} durationInFrames={S2}><BenefitsScene /></Sequence>
      <Sequence from={(offset += S2)} durationInFrames={S3}><RoadmapScene /></Sequence>
      <Sequence from={(offset += S3)} durationInFrames={S4}><IntegrationsScene /></Sequence>
      <Sequence from={(offset += S4)} durationInFrames={S5}><ClosingScene /></Sequence>
    </AbsoluteFill>
  );
};

/* ─── Player Wrapper ───────────────────────────────────────────────────────── */

export function VisionPlayer() {
  return (
    <div
      className="vision-player-sticky"
      style={{
        position: 'sticky',
        top: 0,
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        background: DARK_BG,
      }}
    >
      <Player
        component={VisionVideoComp as unknown as React.ComponentType<Record<string, unknown>>}
        inputProps={{} as unknown as Record<string, unknown>}
        durationInFrames={TOTAL}
        fps={FPS}
        compositionWidth={1920}
        compositionHeight={1080}
        style={{ width: '100%', height: '100%' }}
        loop
        autoPlay
      />
    </div>
  );
}
