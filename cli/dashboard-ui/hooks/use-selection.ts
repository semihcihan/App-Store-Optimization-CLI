import { useEffect, useState } from "react";
import type React from "react";

type KeywordRow = {
  keyword: string;
};

type UseSelectionParams = {
  keywords: KeywordRow[];
  filteredRows: KeywordRow[];
};

export function useSelection(params: UseSelectionParams) {
  const [selectedKeywords, setSelectedKeywords] = useState<Set<string>>(new Set());
  const [selectionAnchor, setSelectionAnchor] = useState<string | null>(null);

  useEffect(() => {
    const keep = new Set(params.keywords.map((row) => row.keyword));
    setSelectedKeywords((prev) => new Set(Array.from(prev).filter((kw) => keep.has(kw))));
    setSelectionAnchor((prev) => (prev && !keep.has(prev) ? null : prev));
  }, [params.keywords]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea" || tag === "select" || target?.isContentEditable) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a") {
        event.preventDefault();
        setSelectedKeywords(new Set(params.keywords.map((row) => row.keyword)));
        setSelectionAnchor(params.keywords.length > 0 ? params.keywords[0].keyword : null);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [params.keywords]);

  const onSelectRow = (
    rowKeyword: string,
    rowIndex: number,
    event: React.MouseEvent<HTMLTableRowElement>
  ) => {
    if (event.shiftKey && selectionAnchor) {
      const start = params.filteredRows.findIndex((r) => r.keyword === selectionAnchor);
      if (start >= 0) {
        const [from, to] = start <= rowIndex ? [start, rowIndex] : [rowIndex, start];
        const next = new Set<string>();
        for (let i = from; i <= to; i += 1) next.add(params.filteredRows[i].keyword);
        setSelectedKeywords(next);
        return;
      }
    }

    if (event.metaKey || event.ctrlKey) {
      setSelectedKeywords((prev) => {
        const next = new Set(prev);
        if (next.has(rowKeyword)) next.delete(rowKeyword);
        else next.add(rowKeyword);
        return next;
      });
      setSelectionAnchor(rowKeyword);
      return;
    }

    if (selectedKeywords.size === 1 && selectedKeywords.has(rowKeyword)) {
      setSelectedKeywords(new Set());
      setSelectionAnchor(null);
      return;
    }

    setSelectedKeywords(new Set([rowKeyword]));
    setSelectionAnchor(rowKeyword);
  };

  return {
    selectedKeywords,
    setSelectedKeywords,
    selectionAnchor,
    setSelectionAnchor,
    onSelectRow,
  };
}
