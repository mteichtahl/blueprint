// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChangeOwnerPanel, OwnerChip, OwnerPicker } from '../src/components/PlanOwner.tsx';

afterEach(cleanup);

const kyra = { sub: 'k', displayName: 'Kyra', jobTitle: 'Founder & Director' };
const sam = { sub: 's', displayName: 'Sam', jobTitle: 'Artist manager' };

describe('plan owner chip (rev 12)', () => {
  it('shows the owner with job title, and Change owner for Blueprint', () => {
    const onChange = vi.fn();
    render(<OwnerChip owner={kyra} ownerNeeded={false} onChange={onChange} />);
    expect(screen.getByText('Kyra')).toBeTruthy();
    expect(screen.getByText('Founder & Director')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Change owner' }));
    expect(onChange).toHaveBeenCalled();
  });
  it('flags a plan that needs an owner; artists get no button', () => {
    render(<OwnerChip owner={null} ownerNeeded />);
    expect(screen.getByText('Needs an owner')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });
});

describe('change plan owner', () => {
  it('says what will move and sends the new owner with the note', () => {
    const onConfirm = vi.fn();
    render(
      <ChangeOwnerPanel
        artistName="Chloe Poli"
        current={kyra}
        candidates={[kyra, sam]}
        movable={4}
        busy={false}
        onConfirm={onConfirm}
        onCancel={() => {}}
      />,
    );
    const go = screen.getByRole('button', { name: 'Change owner' }) as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    // The current owner isn't offered.
    expect(screen.queryByRole('option', { name: /Kyra/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('New owner'), { target: { value: 's' } });
    expect(screen.getByText('4 open to-dos will move to Sam.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Handover note (optional)'), {
      target: { value: 'Call her Monday' },
    });
    fireEvent.click(go);
    expect(onConfirm).toHaveBeenCalledWith('s', 'Call her Monday');
  });
  it('explains when nobody else can own the plan', () => {
    render(
      <ChangeOwnerPanel
        artistName="Chloe Poli"
        current={kyra}
        candidates={[kyra]}
        movable={0}
        busy={false}
        onConfirm={() => {}}
        onCancel={() => {}}
      />,
    );
    expect(screen.getByText(/Nobody else can own Chloe Poli/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Change owner' })).toBeNull();
  });
});

describe('owner picker for a new plan', () => {
  it('lists the Blueprint team and is required', () => {
    const onChange = vi.fn();
    render(<OwnerPicker candidates={[kyra, sam]} value="" onChange={onChange} />);
    const select = screen.getByLabelText('Plan owner') as HTMLSelectElement;
    expect(select.required).toBe(true);
    fireEvent.change(select, { target: { value: 'k' } });
    expect(onChange).toHaveBeenCalledWith('k');
  });
});
