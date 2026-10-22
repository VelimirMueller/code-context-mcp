import { useEffect, useRef } from 'react';
import { useSpring, useReducedMotion, useMotionValue, animate } from 'framer-motion';

interface AnimatedNumberProps {
  value: number;
  duration?: number;
}

export function AnimatedNumber({ value, duration = 600 }: AnimatedNumberProps) {
  const shouldReduce = useReducedMotion();
  const motionValue = useMotionValue(0);
  const spanRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (shouldReduce) {
      if (spanRef.current) spanRef.current.textContent = String(value);
      return;
    }

    const controls = animate(motionValue, value, {
      duration: duration / 1000,
      ease: [0.16, 1, 0.3, 1],
      onUpdate(latest) {
        if (spanRef.current) {
          spanRef.current.textContent = String(Math.round(latest));
        }
      },
    });

    return () => controls.stop();
  }, [value, duration, shouldReduce, motionValue]);

  return (
    <span
      ref={spanRef}
      style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}
    >
      0
    </span>
  );
}
