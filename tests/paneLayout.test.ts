import { describe, it, expect } from 'vitest';
import { reorder } from '../src/shell/paneLayout';

const ORDER = ['reference', 'amp', 'timeline'];

describe('reorder', () => {
  it('moves a pane to the front', () => {
    expect(reorder(ORDER, 'timeline', 0)).toEqual(['timeline', 'reference', 'amp']);
  });

  it('moves a pane to the middle', () => {
    expect(reorder(ORDER, 'reference', 1)).toEqual(['amp', 'reference', 'timeline']);
  });

  it('moves a pane to the end', () => {
    expect(reorder(ORDER, 'reference', 2)).toEqual(['amp', 'timeline', 'reference']);
  });

  it('is a no-op for an unknown id', () => {
    expect(reorder(ORDER, 'nope', 0)).toEqual(ORDER);
  });

  it('clamps an out-of-range index rather than dropping the pane', () => {
    expect(reorder(ORDER, 'reference', 99)).toEqual(['amp', 'timeline', 'reference']);
    expect(reorder(ORDER, 'timeline', -5)).toEqual(['timeline', 'reference', 'amp']);
  });
});
