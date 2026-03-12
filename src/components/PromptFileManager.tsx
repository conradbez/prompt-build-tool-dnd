import { useRef } from 'react';
import { PlusIcon, Trash2Icon, UploadIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter,
  DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';

export interface PromptFileRow {
  id: string;
  name: string;
  file: File | null;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  rows: PromptFileRow[];
  onRowsChange: (rows: PromptFileRow[]) => void;
}

export default function PromptFileManager({ open, onOpenChange, rows, onRowsChange }: Props) {
  // One hidden file input per row, keyed by row id
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const addRow = () =>
    onRowsChange([...rows, { id: crypto.randomUUID(), name: '', file: null }]);

  const updateName = (id: string, name: string) =>
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, name } : r)));

  const updateFile = (id: string, file: File) =>
    onRowsChange(rows.map((r) => (r.id === id ? { ...r, file } : r)));

  const remove = (id: string) => onRowsChange(rows.filter((r) => r.id !== id));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Prompt Files</DialogTitle>
          <DialogDescription>
            Files stored in the browser and sent with each run request as{' '}
            <code className="bg-muted px-1 rounded text-xs">promptfiles</code>. The{' '}
            <strong>key</strong> must match the{' '}
            <code className="bg-muted px-1 rounded text-xs">promptfiles:</code> declaration in
            the model&apos;s config block.
          </DialogDescription>
        </DialogHeader>

        {rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key (name)</TableHead>
                <TableHead>File</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Input
                      value={row.name}
                      onChange={(e) => updateName(row.id, e.target.value)}
                      placeholder="file_key"
                      className="font-mono"
                    />
                  </TableCell>
                  <TableCell>
                    {/* Hidden native file input */}
                    <input
                      type="file"
                      className="hidden"
                      ref={(el) => { fileInputs.current[row.id] = el; }}
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) updateFile(row.id, f);
                      }}
                    />
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => fileInputs.current[row.id]?.click()}
                      >
                        <UploadIcon size={12} />
                        {row.file ? 'Replace' : 'Choose file'}
                      </Button>
                      {row.file && (
                        <span className="text-xs text-muted-foreground truncate max-w-[160px]">
                          {row.file.name}
                        </span>
                      )}
                    </div>
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
            No files yet — add a row and upload a file.
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" onClick={addRow}>
            <PlusIcon size={14} />
            Add file
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
