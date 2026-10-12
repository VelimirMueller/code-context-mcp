import { createRoot } from "react-dom/client";
import { App } from "@/App";
import { formatPrice, slugify } from "@/lib/format.js";
import { Button } from "@/components";
import { thing } from "@decoy/thing";

createRoot(document.body).render(<App title={slugify(formatPrice(thing))} footer={<Button />} />);
