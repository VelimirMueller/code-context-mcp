Fixture for tsconfig/jsconfig path aliases in the import graph (CCA-18, #151).
A Vite-style solution config: tsconfig.json only references tsconfig.app.json
(src) and tsconfig.node.json (vite.config.ts). tsconfig.app.json extends a
package config that is not installed (ignored) and tsconfig.base.json, which
holds `paths` (with a commented-out decoy alias and trailing commas).
packages/ui has its own tsconfig with baseUrl + paths; packages/legacy a
jsconfig.json. All names are synthetic.
