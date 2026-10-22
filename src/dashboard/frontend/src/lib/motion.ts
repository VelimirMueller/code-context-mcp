import { type Variants } from 'framer-motion';

// Page transition variants
export const pageVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -8 },
};

export const pageTransition = {
  type: 'spring' as const,
  stiffness: 300,
  damping: 30,
  mass: 0.8,
};

// Sub-tab content transition
export const tabVariants: Variants = {
  initial: { opacity: 0, x: 10 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, x: -10 },
};

export const tabTransition = {
  type: 'spring' as const,
  stiffness: 400,
  damping: 35,
};

// Sidebar collapse
export const sidebarVariants: Variants = {
  open: { width: 300, opacity: 1 },
  closed: { width: 0, opacity: 0 },
};

// List item stagger
export const listVariants: Variants = {
  animate: { transition: { staggerChildren: 0.03 } },
};

export const listItemVariants: Variants = {
  initial: { opacity: 0, y: 4 },
  animate: { opacity: 1, y: 0 },
};

// Card hover
export const cardHover = {
  scale: 1.01,
  y: -2,
  transition: { type: 'spring' as const, stiffness: 400, damping: 25 },
};

// Respect reduced motion preference
export const reducedMotion = {
  initial: { opacity: 1 },
  animate: { opacity: 1 },
  exit: { opacity: 1 },
};
