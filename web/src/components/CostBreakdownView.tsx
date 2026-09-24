import type { CostBreakdown } from '@shared/api';
import { formatInteger, formatUsd } from '../lib/format';
import { cn } from '../lib/cn';

/** Line items, total and notes of an estimated or actual cost. */
export function CostBreakdownView({
  breakdown,
  totalLabel,
  className,
}: {
  breakdown: CostBreakdown;
  totalLabel?: string;
  className?: string;
}) {
  return (
    <div className={cn('text-sm', className)}>
      <table className="w-full border-collapse">
        <caption className="sr-only">{breakdown.basis === 'actual' ? 'Actual cost' : 'Estimated cost'}</caption>
        <thead className="sr-only">
          <tr>
            <th scope="col">Item</th>
            <th scope="col">Amount</th>
          </tr>
        </thead>
        <tbody>
          {breakdown.items.map((item, index) => (
            <tr key={`${index}-${item.label}`} className="border-b border-line align-top last:border-b-0">
              <td className="py-2 pr-3">
                <span className="block text-fg">{item.label}</span>
                <span className="block text-xs text-subtle tabular-nums">
                  {formatInteger(item.quantity)} {item.unit}
                </span>
              </td>
              <td className="py-2 text-right text-fg tabular-nums">{formatUsd(item.amountUsd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t border-line-strong">
            <th scope="row" className="pt-2.5 text-left font-semibold">
              {totalLabel ?? (breakdown.basis === 'actual' ? 'Actual total' : 'Estimated total')}
            </th>
            <td className="pt-2.5 text-right text-base font-semibold tabular-nums">{formatUsd(breakdown.totalUsd)}</td>
          </tr>
        </tfoot>
      </table>
      {breakdown.notes.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs text-muted">
          {breakdown.notes.map((note) => (
            <li key={note}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
}
