import { useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { get, upload, useLoad } from '../api.js';
import { Button, Card, Empty, ErrorAlert, PageHeader, Spinner, StatusBadge, fmtDate } from '../components/ui.jsx';

export default function Imports() {
  const navigate = useNavigate();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { data: imports, loading } = useLoad(() => get('/imports'));

  async function onFile(file) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const imp = await upload('/imports', form);
      navigate(`/imports/${imp.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Import recruiter workbook"
        subtitle="Every sheet is analyzed separately. You review the column mapping before anything is saved."
        actions={
          <>
            <input ref={fileRef} type="file" accept=".xlsx,.xlsm,.xls,.csv,.ods" className="hidden" onChange={(e) => onFile(e.target.files?.[0])} />
            <Button variant="primary" icon={Upload} loading={busy} onClick={() => fileRef.current?.click()}>
              Upload workbook
            </Button>
          </>
        }
      />
      <ErrorAlert error={error} />
      <Card title="Imports" padded={false}>
        {loading && !imports ? (
          <Spinner />
        ) : !imports?.length ? (
          <Empty icon={FileSpreadsheet} title="No workbooks imported yet">
            Upload your Excel file. Headers, contact groups (HR #1, HR #2…) and student/coordinator columns are detected automatically.
          </Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500">
              <tr>
                <th className="px-4 py-2">File</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Contacts</th>
                <th className="px-4 py-2">Uploaded</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {imports.map((i) => (
                <tr key={i.id} className="hover:bg-slate-50">
                  <td className="px-4 py-2">
                    <Link className="font-medium text-indigo-600 hover:underline" to={`/imports/${i.id}`}>
                      {i.filename}
                    </Link>
                  </td>
                  <td className="px-4 py-2">
                    <StatusBadge status={i.status} />
                  </td>
                  <td className="px-4 py-2 text-slate-600">
                    {i.summary ? `${i.summary.created} new · ${i.summary.mergedWithinImport + i.summary.mergedWithExisting} merged` : '—'}
                  </td>
                  <td className="px-4 py-2 text-slate-500">{fmtDate(i.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
