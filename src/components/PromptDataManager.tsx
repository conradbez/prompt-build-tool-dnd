import { useRef } from 'react';
import { PlusIcon, Trash2Icon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface PromptDataRow {
  id: string;
  name: string;
  value: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: PromptDataRow[];
  onRowsChange: (rows: PromptDataRow[]) => void;
}

export default function PromptDataManager({ open, onOpenChange, rows, onRowsChange }: Props) {
  const addRow = () =>
    onRowsChange([...rows, { id: crypto.randomUUID(), name: '', value: '' }]);

  const update = (id: string, field: 'name' | 'value', val: string) =>
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, [field]: val } : r)));

  const remove = (id: string) => onRowsChange(rows.filter((r) => r.id !== id));

  // Focus the first empty name field when dialog opens
  const firstEmptyRef = useRef<HTMLInputElement>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prompt Data</DialogTitle>
          <DialogDescription>
            Key-value pairs sent as{' '}
            <code className="bg-muted px-1 rounded text-xs">promptdata()</code> variables with
            each run request.
          </DialogDescription>
        </DialogHeader>

        {rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variable name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row, i) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Input
                      ref={i === 0 ? firstEmptyRef : undefined}
                      value={row.name}
                      onChange={(e) => update(row.id, 'name', e.target.value)}
                      placeholder="variable_name"
                      className="font-mono"
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={row.value}
                      onChange={(e) => update(row.id, 'value', e.target.value)}
                      placeholder="value"
                    />
                  </TableCell>
                  <TableCell>
                    <Button variant="ghost" size="icon" onClick={() => remove(row.id)}>
                      <Trash2Icon size={14} />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <p className="text-center text-sm text-muted-foreground py-6">
            No variables yet — add a row to define{' '}
            <code className="bg-muted px-1 rounded text-xs">{'{{ promptdata(\'key\') }}'}</code>{' '}
            values.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={addRow}>
            <PlusIcon size={14} />
            Add variable
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
