import { RunDetail } from '../../../../components/run-detail';
export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  return <RunDetail id={(await params).id} />;
}
