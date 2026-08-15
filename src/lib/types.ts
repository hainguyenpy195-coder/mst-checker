export type Taxpayer = {
  tax_code: string;
  name: string | null;
  org_type: string | null;
  address: string | null;
  tax_department: string | null;
  status: string | null;
  status_group: string | null;
  source_updated_at: string | null;
  previous_checked_at: string | null;
  last_checked_at: string | null;
  status_changed_at: string | null;
  last_error: string | null;
  next_check_at: string | null;
};

export type TaxpayerEvidence = {
  file_name: string;
  content_type: string;
  file_size: number;
  updated_at: string;
};

export type TaxpayerLookupResponse = {
  data: Taxpayer | null;
  meta: {
    stale: boolean;
    refreshRequested: boolean;
  };
};
