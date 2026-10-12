import { Card } from "@/components/index.js";
import { useTotals } from "@/hooks/useTotals";
import { API_URL } from "@shared/config";

export function App(props: { title: string; footer: unknown }) {
  return <Card title={props.title}>{useTotals([1, 2]) + API_URL}</Card>;
}
