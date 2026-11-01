'use client'

import { useMemo } from 'react'
import { useFormName, useGetFieldValue, useSetDefaultValue, useSetFieldValue } from '@openuidev/react-lang'
import { EditableTable, type EditableTableRow } from '@openuidev/react-ui'

type Column = { type: 'text' | 'number' | 'date-single' | 'select' | 'url'; key: string; header: string; width?: number; options?: { value: string; label: string }[] }
type Row = { id: string; values: (string | number)[] }

/**
 * OpenUI's EditableTable grid, writing every edit straight into its Form, so
 * the Form's own button sends the rows as they stand. OpenUI's version keeps
 * edits until its English "Save Changes" bar is pressed.
 */
export function AgentEditableTable({ name = '', columns = [], data = [] }: { name?: string; columns?: Column[]; data?: Row[] }) {
  const formName = useFormName() ?? name
  const getFieldValue = useGetFieldValue()
  const setFieldValue = useSetFieldValue()
  const keys = useMemo(() => columns.map(column => column.key), [columns])
  const existing = getFieldValue(formName, name) as Row[] | undefined
  useSetDefaultValue({ formName, componentType: 'EditableTable', name, existingValue: existing, defaultValue: data })
  const rows = useMemo(() => (existing ?? data).map(row => ({ id: row.id, ...Object.fromEntries(keys.map((key, index) => [key, row.values?.[index]])) })), [existing, data, keys])
  const onDataChange = (changed: EditableTableRow[]) => setFieldValue(formName, 'EditableTable', name, changed.map(row => ({ id: row.id, values: keys.map(key => row[key]) })))
  return <div className="w-full min-w-0 overflow-x-auto"><EditableTable data={rows} columns={columns} onDataChange={onDataChange} /></div>
}
