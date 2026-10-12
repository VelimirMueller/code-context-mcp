import clsx from "clsx";
import { tone } from "src/theme/tone";
import { App } from "@/App";

export function Badge() {
  return <span className={clsx(tone(), String(App))} />;
}
