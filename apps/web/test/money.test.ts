import { describe, expect, it } from 'vitest';
import { defaultMoney, summary } from '../src/components/Money.tsx';

describe('gig money', () => {
  it('starts with a Merchandise cost row', () => {
    expect(defaultMoney().costs.at(-1)?.label).toBe('Merchandise');
    expect(defaultMoney().merchTakingsCents).toBe(0);
  });

  it('adds merchandise sales to takings and works out merch profit', () => {
    const s = summary({
      ticketsSold: 100,
      takingsCents: 200000,
      merchTakingsCents: 60000,
      costs: [
        { id: 'p1', label: 'Venue', amountCents: 50000 },
        { id: 'p7', label: 'Merchandise', amountCents: 25000 },
      ],
    });
    expect(s).toEqual({
      costsCents: 75000,
      merchCostCents: 25000,
      totalTakingsCents: 260000,
      profitCents: 185000,
      merchProfitCents: 35000,
      perTicketCents: 2000,
    });
  });

  it('reads figures saved before merchandise existed', () => {
    const s = summary({ ticketsSold: 0, takingsCents: 1000, costs: [] });
    expect(s.totalTakingsCents).toBe(1000);
    expect(s.profitCents).toBe(1000);
  });
});
