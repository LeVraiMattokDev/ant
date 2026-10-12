import type { ReactNode } from 'react';
import { WorkspaceMark } from './layout/WorkspaceMark';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="safe-top safe-bottom scroll-y flex min-h-full flex-col items-center px-4 py-10 sm:justify-center">
      <div className="w-full max-w-[420px]">
        <div className="mb-8 flex items-center gap-2.5 text-[17px] font-semibold tracking-[-0.01em]">
          <WorkspaceMark size={32} />
          Ant
        </div>
        <div className="rounded-[20px] border border-line bg-surface p-6 shadow-[0_1px_2px_rgb(0_0_0/0.15)]">
          <h1 className="text-[20px] font-semibold tracking-[-0.02em]">{title}</h1>
          {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-[8px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {message}
    </div>
  );
}
