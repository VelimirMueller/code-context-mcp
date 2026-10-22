interface StatProps {
  value: string | number;
  label: string;
  mono?: boolean;
}

export function Stat({ value, label, mono = true }: StatProps) {
  return (
    <div className="flex flex-col items-center gap-[2px]">
      <span
        className={`${mono ? 'font-code' : 'font-body'} text-[15px] leading-none font-semibold text-fg`}
      >
        {value}
      </span>
      <span className="text-10 tracking-[0.06em] text-fg-3 uppercase">{label}</span>
    </div>
  );
}
