// lint-staged: type-check, lint and format staged files. Never a full build.
// tsc runs once per commit on its project: a file list would ignore tsconfig.json.
const posix = (f) => f.replace(/\\/g, '/');
const inApp = (f) => posix(f).includes('/src/dashboard/app/');
const inRemotion = (f) => posix(f).includes('/src/remotion/');

export default {
  'src/**/*.{ts,tsx,mts}': (files) => {
    const cmds = [];
    if (files.some((f) => !inApp(f) && !inRemotion(f))) cmds.push('tsc --noEmit');
    if (files.some(inApp)) cmds.push('tsc --noEmit -p src/dashboard/app');
    return cmds;
  },
  '*.{ts,tsx,js,jsx,mjs,cjs,mts}': [
    'eslint --no-warn-ignored',
    'prettier --write --ignore-unknown',
  ],
  '*.{json,md,yml,yaml,css,html}': 'prettier --write --ignore-unknown',
};
