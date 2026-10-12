import { useState } from 'react';
import { Copy, Download } from 'lucide-react';
import { copyText, downloadText } from '../lib/clipboard';

export function RecoveryCodes({ codes }: { codes: string[] }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join('\n');
  return (
    <div>
      <ol className="mono grid grid-cols-2 gap-x-6 gap-y-1.5 rounded-[6px] border border-line bg-bg p-4 text-[13.5px]">
        {codes.map((c, i) => (
          <li key={c} className="flex gap-2">
            <span className="w-5 text-right text-subtle">{i + 1}.</span>
            <span className="select-all">{c}</span>
          </li>
        ))}
      </ol>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            void copyText(text).then((ok) => {
              setCopied(ok);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          <Copy className="size-3.5" />
          {copied ? 'Copiés' : 'Copier'}
        </button>
        <button
          type="button"
          className="btn btn-sm"
          onClick={() =>
            downloadText(
              'ant-codes-de-secours.txt',
              `Codes de secours Ant, générés le ${new Date().toLocaleString('fr-CH')}\nChaque code ne sert qu’une seule fois.\n\n${text}\n`,
            )
          }
        >
          <Download className="size-3.5" />
          Télécharger
        </button>
      </div>
    </div>
  );
}
