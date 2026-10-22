"use client";

import {Calendar} from "@heroui/react";

import {parseDate} from '@internationalized/date';

export function YearPicker({label, value, min, max, disabled, onChange}: {label: string; value: string; min?: string; max?: string; disabled?: boolean; onChange: (value: string) => void}) {
  return (
    <Calendar aria-label={label} value={value ? parseDate(value) : null} minValue={min ? parseDate(min) : undefined} maxValue={max ? parseDate(max) : undefined} isDisabled={disabled} onChange={date => onChange(date.toString())}>
      <Calendar.Header>
        <Calendar.YearPickerTrigger>
          <Calendar.YearPickerTriggerHeading />
          <Calendar.YearPickerTriggerIndicator />
        </Calendar.YearPickerTrigger>
        <Calendar.NavButton slot="previous" />
        <Calendar.NavButton slot="next" />
      </Calendar.Header>
      <Calendar.Grid>
        <Calendar.GridHeader>
          {(day) => <Calendar.HeaderCell>{day}</Calendar.HeaderCell>}
        </Calendar.GridHeader>
        <Calendar.GridBody>{(date) => <Calendar.Cell date={date} />}</Calendar.GridBody>
      </Calendar.Grid>
      <Calendar.YearPickerGrid>
        <Calendar.YearPickerGridBody>
          {({year}) => <Calendar.YearPickerCell year={year} />}
        </Calendar.YearPickerGridBody>
      </Calendar.YearPickerGrid>
    </Calendar>
  );
}
