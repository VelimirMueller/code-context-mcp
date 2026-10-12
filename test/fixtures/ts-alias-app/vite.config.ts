import { defineConfig } from "vite";
// tsconfig.node.json governs this file and has no paths: "@/" is not an alias here.
import { slugify } from "@/lib/format";

export default defineConfig({ base: slugify("app") });
