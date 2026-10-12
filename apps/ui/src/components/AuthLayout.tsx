import type { ReactNode } from 'react';
import { BrandMark } from './layout/BrandMark';

export function AuthLayout({ title, subtitle, children }: { title: string; subtitle?: ReactNode; children: ReactNode }) {
  return (
    <div className="safe-top safe-bottom scroll-y flex min-h-full flex-col items-center px-4 py-10 sm:justify-center">
      <div className="w-full max-w-[400px]">
        <div className="mb-6 flex items-center gap-2 text-[15px] font-semibold">
          <BrandMark className="size-6" />
          Ant
        </div>
        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">{title}</h1>
        {subtitle && <p className="mt-1 text-[13.5px] text-muted">{subtitle}</p>}
        <div className="mt-6">{children}</div>
      </div>
    </div>
  );
}

export function FormError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="rounded-[4px] border border-danger/40 bg-danger-soft px-3 py-2 text-[13px] text-danger">
      {message}
    </div>
  );
}
