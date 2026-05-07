'use client';

import RuleBuilder from '@/components/task-rules/RuleBuilder';
import { useParams } from 'next/navigation';

export default function EditRulePage() {
  const params = useParams();
  const ruleId = params.id as string;

  return <RuleBuilder ruleId={ruleId} />;
}
