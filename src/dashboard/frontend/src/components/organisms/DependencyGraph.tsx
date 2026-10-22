import React, { useEffect, useRef, useCallback } from 'react';
import { useFileStore } from '@/stores/fileStore';

export function DependencyGraph() {
  const graphData = useFileStore((s) => s.graphData);
  const selectedFileId = useFileStore((s) => s.selectedFileId);
  const loadingGraph = useFileStore((s) => s.loading.graph);
  const fetchGraph = useFileStore((s) => s.fetchGraph);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const renderGraph = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container || !graphData || !graphData.nodes.length) {
      if (canvas && container) {
        const rect = container.getBoundingClientRect();
        const ctx = canvas.getContext('2d');
        if (ctx) {
          canvas.width = rect.width * devicePixelRatio;
          canvas.height = rect.height * devicePixelRatio;
          canvas.style.width = rect.width + 'px';
          canvas.style.height = rect.height + 'px';
          ctx.scale(devicePixelRatio, devicePixelRatio);
          ctx.clearRect(0, 0, rect.width, rect.height);
          ctx.font = '500 14px Geist Sans, system-ui, sans-serif';
          ctx.fillStyle = '#63637a';
          ctx.textAlign = 'center';
          ctx.fillText(
            loadingGraph ? 'Loading graph…' : 'No graph data available',
            rect.width / 2,
            rect.height / 2,
          );
        }
      }
      return;
    }

    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    const ctx = canvas.getContext('2d')!;
    ctx.scale(devicePixelRatio, devicePixelRatio);
    const W = rect.width;
    const H = rect.height;

    // Filter to selected file subgraph if a file is selected
    let visibleNodeIds: Set<string | number> | null = null;
    if (selectedFileId) {
      visibleNodeIds = new Set<string | number>();
      visibleNodeIds.add(selectedFileId);
      visibleNodeIds.add(String(selectedFileId));
      for (const e of graphData.edges) {
        if (String(e.source) === String(selectedFileId)) {
          visibleNodeIds.add(e.target);
          visibleNodeIds.add(String(e.target));
        }
        if (String(e.target) === String(selectedFileId)) {
          visibleNodeIds.add(e.source);
          visibleNodeIds.add(String(e.source));
        }
      }
    }

    const filteredNodes = visibleNodeIds
      ? graphData.nodes.filter(
          (n) => visibleNodeIds!.has(n.id) || visibleNodeIds!.has(String(n.id)),
        )
      : graphData.nodes;
    const filteredEdges = visibleNodeIds
      ? graphData.edges.filter(
          (e) =>
            (visibleNodeIds!.has(e.source) || visibleNodeIds!.has(String(e.source))) &&
            (visibleNodeIds!.has(e.target) || visibleNodeIds!.has(String(e.target))),
        )
      : graphData.edges;

    if (!filteredNodes.length) {
      ctx.clearRect(0, 0, W, H);
      ctx.font = '500 14px Geist Sans, system-ui, sans-serif';
      ctx.fillStyle = '#63637a';
      ctx.textAlign = 'center';
      ctx.fillText('No dependencies for this file', W / 2, H / 2);
      return;
    }

    interface SimNode {
      id: string | number;
      label: string;
      x: number;
      y: number;
      vx: number;
      vy: number;
    }

    const nodes: SimNode[] = filteredNodes.map((n) => ({
      ...n,
      x: W / 2 + (Math.random() - 0.5) * W * 0.6,
      y: H / 2 + (Math.random() - 0.5) * H * 0.6,
      vx: 0,
      vy: 0,
    }));

    const idMap: Record<string, SimNode> = {};
    nodes.forEach((n) => {
      idMap[String(n.id)] = n;
    });
    const edges = filteredEdges.filter((e) => idMap[String(e.source)] && idMap[String(e.target)]);

    const repulse = visibleNodeIds ? 15000 : 10000;
    const idealDist = visibleNodeIds ? 180 : 140;

    for (let iter = 0; iter < 250; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[j].x - nodes[i].x;
          const dy = nodes[j].y - nodes[i].y;
          const d = Math.sqrt(dx * dx + dy * dy) || 1;
          const f = repulse / (d * d);
          nodes[i].vx -= (dx / d) * f;
          nodes[i].vy -= (dy / d) * f;
          nodes[j].vx += (dx / d) * f;
          nodes[j].vy += (dy / d) * f;
        }
      }
      for (const e of edges) {
        const s = idMap[String(e.source)];
        const t = idMap[String(e.target)];
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const f = (d - idealDist) * 0.05;
        s.vx += (dx / d) * f;
        s.vy += (dy / d) * f;
        t.vx -= (dx / d) * f;
        t.vy -= (dy / d) * f;
      }
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.008;
        n.vy += (H / 2 - n.y) * 0.008;
        n.x += n.vx * 0.3;
        n.y += n.vy * 0.3;
        n.vx *= 0.55;
        n.vy *= 0.55;
        n.x = Math.max(80, Math.min(W - 80, n.x));
        n.y = Math.max(40, Math.min(H - 40, n.y));
      }
    }

    ctx.clearRect(0, 0, W, H);

    // Draw edges
    for (const e of edges) {
      const s = idMap[String(e.source)];
      const t = idMap[String(e.target)];
      const isFromSelected = selectedFileId && String(e.source) === String(selectedFileId);
      const isToSelected = selectedFileId && String(e.target) === String(selectedFileId);
      const edgeColor = isFromSelected
        ? 'rgba(16,185,129,.5)'
        : isToSelected
          ? 'rgba(167,139,250,.5)'
          : 'rgba(59,130,246,.35)';
      const edgeGlow = isFromSelected
        ? 'rgba(16,185,129,.1)'
        : isToSelected
          ? 'rgba(167,139,250,.1)'
          : 'rgba(59,130,246,.1)';

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = edgeGlow;
      ctx.lineWidth = 4;
      ctx.stroke();

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = edgeColor;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      const angle = Math.atan2(t.y - s.y, t.x - s.x);
      const mx = (s.x + t.x) / 2;
      const my = (s.y + t.y) / 2;
      ctx.beginPath();
      ctx.moveTo(mx + 8 * Math.cos(angle), my + 8 * Math.sin(angle));
      ctx.lineTo(mx - 8 * Math.cos(angle - 0.4), my - 8 * Math.sin(angle - 0.4));
      ctx.lineTo(mx - 8 * Math.cos(angle + 0.4), my - 8 * Math.sin(angle + 0.4));
      ctx.closePath();
      ctx.fillStyle = edgeColor;
      ctx.fill();
    }

    // Draw nodes
    for (const n of nodes) {
      const isSelected =
        selectedFileId && (n.id === selectedFileId || n.id === String(selectedFileId));
      const nodeColor = isSelected ? '#10b981' : '#60a5fa';
      const nodeStroke = isSelected ? '#34d399' : '#60a5fa';
      const nodeRadius = isSelected ? 7 : 5;
      const glowRadius = isSelected ? 20 : 14;

      ctx.beginPath();
      ctx.arc(n.x, n.y, glowRadius, 0, Math.PI * 2);
      const glow = ctx.createRadialGradient(n.x, n.y, 2, n.x, n.y, glowRadius);
      glow.addColorStop(0, isSelected ? 'rgba(16,185,129,.25)' : 'rgba(59,130,246,.15)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fill();

      ctx.beginPath();
      ctx.arc(n.x, n.y, nodeRadius, 0, Math.PI * 2);
      ctx.fillStyle = nodeColor;
      ctx.fill();
      ctx.strokeStyle = nodeStroke;
      ctx.lineWidth = 1.5;
      ctx.stroke();

      ctx.font = isSelected
        ? '600 12px Geist Sans, system-ui, sans-serif'
        : '500 11px Geist Sans, system-ui, sans-serif';
      ctx.fillStyle = isSelected ? '#e4e4e7' : '#a1a1aa';
      ctx.textAlign = 'center';
      ctx.fillText(n.label, n.x, n.y + (isSelected ? 24 : 20));
    }
  }, [graphData, selectedFileId, loadingGraph]);

  // Fetch graph data on mount if not loaded
  useEffect(() => {
    if (!graphData) fetchGraph();
  }, [graphData, fetchGraph]);

  // Render whenever data/selection changes
  useEffect(() => {
    renderGraph();
  }, [renderGraph]);

  // Re-render on window resize
  useEffect(() => {
    window.addEventListener('resize', renderGraph);
    return () => window.removeEventListener('resize', renderGraph);
  }, [renderGraph]);

  return (
    <div
      ref={containerRef}
      style={{ flex: 1, position: 'relative', overflow: 'hidden', background: 'var(--bg)' }}
    >
      <canvas ref={canvasRef} style={{ display: 'block' }} />
    </div>
  );
}
