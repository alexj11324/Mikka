import type { ReactNode } from "react";

/** Calendar dates, independent of a browser's timezone: YYYY-MM-DD. */
export interface DateRange {
  from: string;
  to?: string;
}
export interface DateRangePreset {
  label: string;
  value: DateRange;
}
/** Mikka: visible and assistive text, so the host can translate it. */
export interface DateRangePickerLabels {
  startDate: string;
  endDate: string;
  selectDate: string;
  selectEnd: string;
  chooseMonth: string;
  chooseYear: string;
  previousMonth: string;
  nextMonth: string;
  previousYear: string;
  nextYear: string;
  previousYears: string;
  nextYears: string;
  monthsIn: (year: number) => string;
  yearsFrom: (start: number, end: number) => string;
  keyboardHelp: string;
  daysSelected: (count: number) => string;
  chooseStartDate: string;
  chooseEndDate: string;
  clear: string;
  clearRange: string;
  startChosen: (date: string) => string;
  unavailableRange: string;
  rangeSelected: (from: string, to: string) => string;
  cleared: string;
  presetSelected: (name: string) => string;
}
export interface DateRangePickerProps {
  value?: DateRange | null;
  defaultValue?: DateRange | null;
  onValueChange?: (range: DateRange | null) => void;
  defaultMonth?: string;
  min?: string;
  max?: string;
  isDateDisabled?: (date: string) => boolean;
  presets?: DateRangePreset[];
  locale?: string;
  label?: string;
  labels?: Partial<DateRangePickerLabels>;
  disabled?: boolean;
  /** Move focus to the active date on mount, for use inside a popover. */
  autoFocus?: boolean;
  /** Show the start/end summary above the calendar. Default true. */
  showSummary?: boolean;
  className?: string;
  /** Compose custom controls; omitted children render the inline calendar. */
  children?: ReactNode;
  open?: boolean;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Close an open popover after a complete range or preset. Default false. */
  closeOnSelect?: boolean;
}
