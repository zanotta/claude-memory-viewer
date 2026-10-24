import type {
  ApiError,
  FileContent,
  Overview,
  ProjectDetail,
  SearchResponse,
} from '../shared/types.js';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as Partial<ApiError>;
      if (body.error) message = body.error;
    } catch {
      // keep the generic message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export const api = {
  overview: (): Promise<Overview> => getJson('/api/overview'),
  project: (id: string): Promise<ProjectDetail> => getJson(`/api/projects/${encodeURIComponent(id)}`),
  file: (project: string, path: string): Promise<FileContent> =>
    getJson(`/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(path)}`),
  search: (q: string): Promise<SearchResponse> => getJson(`/api/search?q=${encodeURIComponent(q)}`),
};
