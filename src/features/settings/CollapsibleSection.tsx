import { useState, type ReactNode } from 'react';

interface CollapsibleSectionProps {
  title: string;
  description?: string;
  /** 初期状態で開いておくか（既定false）。設定画面はAzure Speechのみ初期展開する。 */
  defaultOpen?: boolean;
  children: ReactNode;
}

/**
 * 設定画面の各セクション用カード（DESIGN.md §2「各セクションは折りたたみ可能なカードで整理」）。
 * 閉じている間は子要素をアンマウントする。これによりVoiceSection等の「開いた瞬間に
 * appStateを読み直す」useEffectが、他セクションでの保存後に再オープンされた時ちゃんと
 * 最新値を拾い直せる（セクション間でpropsを渡し合う複雑な同期を避けるための単純化）。
 */
export function CollapsibleSection({ title, description, defaultOpen = false, children }: CollapsibleSectionProps) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <section className="rounded-xl border border-neutral-200">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 px-4 py-3 text-left"
      >
        <span className="flex flex-col">
          <span className="text-sm font-semibold text-neutral-800">{title}</span>
          {description ? <span className="mt-0.5 text-xs text-neutral-400">{description}</span> : null}
        </span>
        <span
          aria-hidden="true"
          className={`shrink-0 text-neutral-400 transition-transform ${open ? 'rotate-180' : ''}`}
        >
          ▾
        </span>
      </button>
      {open ? <div className="flex flex-col gap-3 border-t border-neutral-100 px-4 py-3">{children}</div> : null}
    </section>
  );
}
