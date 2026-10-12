import { slugify } from "@/lib/format";

export function Card(props: { title: string; children?: unknown }) {
  return <section id={slugify(props.title)}>{props.children as string}</section>;
}
