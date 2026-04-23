import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Badge, Button, Card, Input } from "../ui-react";
import { cx } from "../ui-react/primitives";
import { getIconUrl } from "../app-helpers";
import {
  COMPARE_MAX_APPS,
  COMPARE_MAX_KEYWORDS,
  COMPARE_MIN_APPS,
} from "../../shared/compare-types";
import type {
  CompareMatrixCell,
  CompareMatrixResponse,
  CompareMatrixRow,
  CompareUniverseKeyword,
} from "../../shared/compare-types";
import {
  loadPersistedCompareState,
  persistCompareState,
  useCompareMatrix,
  useCompareSort,
  useCompareUniverse,
  useSortedMatrixRows,
} from "../hooks/use-compare";
import type { CompareSort } from "../hooks/use-compare";

type AppItem = {
  id: string;
  name: string;
  icon?: Record<string, unknown>;
};

type CompareViewProps = {
  apps: AppItem[];
  currentAppId: string | null;
  country: string;
  initialKeywords?: string[];
  onExit: () => void;
};

function dedupe(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function formatRank(value: number | null): string {
  if (value == null) return "";
  return String(value);
}

function rankTintClass(currentPosition: number | null): string {
  if (currentPosition == null) return "";
  if (currentPosition <= 10) return "compare-cell--tier-top";
  if (currentPosition <= 50) return "compare-cell--tier-high";
  if (currentPosition <= 100) return "compare-cell--tier-mid";
  return "";
}

function describeCell(cell: CompareMatrixCell, isResearched: boolean): string {
  if (!isResearched) return "No data — keyword has not been researched yet";
  if (cell.currentPosition == null && !cell.isTracked)
    return "Outside top 200 (and app does not track this keyword)";
  if (cell.currentPosition == null) return "Outside top 200";
  const suffix = cell.isTracked ? " (tracked by this app)" : "";
  if (cell.change == null) return `Rank ${cell.currentPosition}${suffix}`;
  const changeLabel =
    cell.change > 0
      ? `up ${cell.change}`
      : cell.change < 0
        ? `down ${Math.abs(cell.change)}`
        : "no change";
  return `Rank ${cell.currentPosition}, ${changeLabel}${suffix}`;
}

function CompareCellContent({
  cell,
  row,
}: {
  cell: CompareMatrixCell;
  row: CompareMatrixRow;
}) {
  if (row.status === "not_researched") {
    return (
      <div className="compare-cell-inner compare-cell--pending">
        <span className="compare-cell-mark" aria-hidden="true">
          ·
        </span>
      </div>
    );
  }
  if (cell.currentPosition == null) {
    return (
      <div
        className={cx(
          "compare-cell-inner compare-cell--empty",
          !cell.isTracked && "compare-cell--untracked"
        )}
      >
        <span className="compare-cell-mark" aria-hidden="true">
          —
        </span>
      </div>
    );
  }
  const changeLabel =
    cell.change == null
      ? null
      : cell.change > 0
        ? `▲ ${cell.change}`
        : cell.change < 0
          ? `▼ ${Math.abs(cell.change)}`
          : "—";
  return (
    <div className="compare-cell-inner">
      <span className="compare-cell-rank">{formatRank(cell.currentPosition)}</span>
      {changeLabel ? (
        <span
          className={cx(
            "compare-cell-change",
            cell.change != null && cell.change > 0 && "compare-cell-change--up",
            cell.change != null && cell.change < 0 && "compare-cell-change--down"
          )}
        >
          {changeLabel}
        </span>
      ) : null}
      {cell.isTracked ? (
        <span
          className="compare-cell-tracked-dot"
          aria-label="Tracked by this app"
          title="Tracked by this app"
        />
      ) : null}
    </div>
  );
}

export function CompareView({
  apps,
  currentAppId,
  country,
  initialKeywords = [],
  onExit,
}: CompareViewProps) {
  const persisted = useMemo(() => loadPersistedCompareState(), []);
  const ownedAppIdSet = useMemo(
    () => new Set(apps.map((app) => app.id)),
    [apps]
  );
  const initialAppIds = useMemo(() => {
    if (persisted) {
      const filtered = persisted.appIds.filter((id) => ownedAppIdSet.has(id));
      if (filtered.length >= COMPARE_MIN_APPS) return filtered;
    }
    const seeded: string[] = [];
    if (currentAppId && ownedAppIdSet.has(currentAppId)) {
      seeded.push(currentAppId);
    }
    for (const app of apps) {
      if (seeded.length >= COMPARE_MIN_APPS) break;
      if (!seeded.includes(app.id)) seeded.push(app.id);
    }
    return seeded;
  }, [persisted, ownedAppIdSet, currentAppId, apps]);

  const [selectedAppIds, setSelectedAppIds] = useState<string[]>(initialAppIds);
  const [selectedKeywords, setSelectedKeywords] = useState<string[]>(() => {
    if (persisted && persisted.keywords.length > 0) return persisted.keywords;
    if (initialKeywords.length > 0)
      return initialKeywords.slice(0, COMPARE_MAX_KEYWORDS);
    return [];
  });
  const [appPickerOpen, setAppPickerOpen] = useState(false);
  const [keywordSearch, setKeywordSearch] = useState("");
  const [showAllKeywords, setShowAllKeywords] = useState(false);
  const [isMatrixFullscreen, setIsMatrixFullscreen] = useState(false);
  const appPickerRef = useRef<HTMLDivElement | null>(null);

  const { sort, setSort, toggleSort } = useCompareSort(persisted?.sortBy);

  const enabled = selectedAppIds.length >= COMPARE_MIN_APPS;

  const { universe, isUniverseLoading, universeError } = useCompareUniverse(
    selectedAppIds,
    country,
    enabled
  );

  useEffect(() => {
    if (!universe) return;
    if (selectedKeywords.length > 0) return;
    if (initialKeywords.length > 0) return;
    const appIdsSeed = selectedAppIds.slice();
    const firstAppId = currentAppId ?? appIdsSeed[0];
    if (!firstAppId) return;
    const seedKeywords = universe.keywords
      .filter((kw) => kw.trackedByAppIds.includes(firstAppId))
      .map((kw) => kw.keyword)
      .slice(0, 25);
    if (seedKeywords.length === 0) {
      const fallback = universe.keywords
        .slice(0, 10)
        .map((kw) => kw.keyword);
      if (fallback.length === 0) return;
      setSelectedKeywords(fallback);
      return;
    }
    setSelectedKeywords(seedKeywords);
  }, [universe, selectedKeywords.length, initialKeywords.length, currentAppId, selectedAppIds.join(",")]);

  const { matrix, isMatrixLoading, matrixError } = useCompareMatrix(
    selectedAppIds,
    selectedKeywords,
    country,
    enabled
  );

  useEffect(() => {
    if (selectedAppIds.length < COMPARE_MIN_APPS) return;
    persistCompareState({
      appIds: selectedAppIds,
      keywords: selectedKeywords,
      sortBy: sort,
      country,
    });
  }, [selectedAppIds.join(","), selectedKeywords.join(","), sort, country]);

  useEffect(() => {
    if (!appPickerOpen) return;
    const handleClickOutside = (event: MouseEvent) => {
      if (!appPickerRef.current) return;
      if (!(event.target instanceof Node)) return;
      if (appPickerRef.current.contains(event.target)) return;
      setAppPickerOpen(false);
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [appPickerOpen]);

  useEffect(() => {
    if (!isMatrixFullscreen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setIsMatrixFullscreen(false);
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
    };
  }, [isMatrixFullscreen]);

  const appById = useMemo(() => {
    const map = new Map<string, AppItem>();
    for (const app of apps) map.set(app.id, app);
    return map;
  }, [apps]);

  const selectedApps = useMemo(
    () =>
      selectedAppIds
        .map((id) => appById.get(id))
        .filter((app): app is AppItem => Boolean(app)),
    [selectedAppIds, appById]
  );

  const universeById = useMemo(() => {
    const map = new Map<string, CompareUniverseKeyword>();
    if (!universe) return map;
    for (const keyword of universe.keywords) {
      map.set(keyword.keyword, keyword);
    }
    return map;
  }, [universe]);

  const filteredUniverseKeywords = useMemo(() => {
    if (!universe) return [] as CompareUniverseKeyword[];
    const term = keywordSearch.trim().toLowerCase();
    let keywords = universe.keywords;
    if (term) {
      keywords = keywords.filter((kw) =>
        kw.keyword.toLowerCase().includes(term)
      );
    }
    if (!showAllKeywords) {
      keywords = keywords.filter(
        (kw) => kw.trackedCount >= selectedAppIds.length
      );
      if (keywords.length === 0) {
        keywords = universe.keywords.filter((kw) =>
          term ? kw.keyword.toLowerCase().includes(term) : true
        );
      }
    }
    return keywords;
  }, [universe, keywordSearch, showAllKeywords, selectedAppIds.length]);

  const selectedKeywordSet = useMemo(
    () => new Set(selectedKeywords),
    [selectedKeywords]
  );

  const sortedRows = useSortedMatrixRows(matrix, sort);

  const canAddMoreApps = selectedAppIds.length < COMPARE_MAX_APPS;
  const canAddMoreKeywords = selectedKeywords.length < COMPARE_MAX_KEYWORDS;

  const handleToggleApp = useCallback(
    (appId: string) => {
      setSelectedAppIds((current) => {
        if (current.includes(appId)) {
          const next = current.filter((id) => id !== appId);
          return next;
        }
        if (current.length >= COMPARE_MAX_APPS) return current;
        return [...current, appId];
      });
    },
    []
  );

  const handleRemoveApp = useCallback((appId: string) => {
    setSelectedAppIds((current) => current.filter((id) => id !== appId));
    setSort((current) =>
      current.kind === "rank" && current.appId === appId
        ? { kind: "keyword", dir: "asc" }
        : current
    );
  }, [setSort]);

  const handleToggleKeyword = useCallback(
    (keyword: string) => {
      setSelectedKeywords((current) => {
        if (current.includes(keyword)) {
          return current.filter((k) => k !== keyword);
        }
        if (current.length >= COMPARE_MAX_KEYWORDS) return current;
        return [...current, keyword];
      });
    },
    []
  );

  const handleRemoveKeyword = useCallback((keyword: string) => {
    setSelectedKeywords((current) => current.filter((k) => k !== keyword));
  }, []);

  const handleClearKeywords = useCallback(() => {
    setSelectedKeywords([]);
  }, []);

  const handleSelectAllVisible = useCallback(() => {
    setSelectedKeywords((current) => {
      const next = new Set(current);
      for (const kw of filteredUniverseKeywords) {
        if (next.size >= COMPARE_MAX_KEYWORDS) break;
        next.add(kw.keyword);
      }
      return dedupe(Array.from(next));
    });
  }, [filteredUniverseKeywords]);

  const availableApps = useMemo(
    () => apps.filter((app) => !selectedAppIds.includes(app.id)),
    [apps, selectedAppIds]
  );

  const renderHeaderSortArrow = (active: boolean, dir: "asc" | "desc") => {
    if (!active) return null;
    return <span className="compare-sort-arrow">{dir === "asc" ? "▲" : "▼"}</span>;
  };

  return (
    <div className="compare-shell">
      <div className="compare-breadcrumb">
        <span className="compare-breadcrumb-muted">KEYWORDS / </span>
        <span>
          COMPARE ({selectedAppIds.length} APPS, {selectedKeywords.length}{" "}
          KEYWORDS)
        </span>
        <Button
          id="compare-exit"
          variant="ghost"
          size="sm"
          type="button"
          onClick={onExit}
        >
          × Exit compare
        </Button>
      </div>

      <Card className="compare-toolbar">
        <div className="compare-chip-rail" aria-label="Selected apps">
          {selectedApps.map((app) => {
            const iconUrl = getIconUrl({
              appId: app.id,
              name: app.name,
              icon: app.icon,
            });
            return (
              <span key={app.id} className="compare-chip">
                {iconUrl ? (
                  <img
                    className="compare-chip-icon"
                    src={iconUrl}
                    alt=""
                    loading="lazy"
                  />
                ) : (
                  <span className="compare-chip-initials" aria-hidden="true">
                    {app.name.slice(0, 1).toUpperCase()}
                  </span>
                )}
                <span className="compare-chip-label">{app.name}</span>
                <button
                  type="button"
                  className="compare-chip-remove"
                  aria-label={`Remove ${app.name}`}
                  onClick={() => handleRemoveApp(app.id)}
                  disabled={selectedAppIds.length <= COMPARE_MIN_APPS}
                >
                  ×
                </button>
              </span>
            );
          })}
          <div className="compare-chip-add" ref={appPickerRef}>
            <Button
              id="compare-add-app"
              variant="outline"
              size="sm"
              type="button"
              disabled={!canAddMoreApps || availableApps.length === 0}
              onClick={() => setAppPickerOpen((v) => !v)}
            >
              + Add app
            </Button>
            {appPickerOpen ? (
              <div className="compare-app-picker" role="listbox">
                {availableApps.length === 0 ? (
                  <div className="compare-app-picker-empty">
                    No more apps to add.
                  </div>
                ) : (
                  availableApps.map((app) => {
                    const iconUrl = getIconUrl({
                      appId: app.id,
                      name: app.name,
                      icon: app.icon,
                    });
                    return (
                      <button
                        key={app.id}
                        type="button"
                        className="compare-app-picker-row"
                        onClick={() => {
                          handleToggleApp(app.id);
                          setAppPickerOpen(false);
                        }}
                      >
                        {iconUrl ? (
                          <img
                            src={iconUrl}
                            alt=""
                            className="compare-chip-icon"
                            loading="lazy"
                          />
                        ) : (
                          <span
                            className="compare-chip-initials"
                            aria-hidden="true"
                          >
                            {app.name.slice(0, 1).toUpperCase()}
                          </span>
                        )}
                        <span className="compare-chip-label">{app.name}</span>
                      </button>
                    );
                  })
                )}
              </div>
            ) : null}
          </div>
          <Badge className="compare-limit-badge">
            {selectedAppIds.length} / {COMPARE_MAX_APPS} APPS
          </Badge>
        </div>

        <div className="compare-keyword-controls">
          <div className="compare-keyword-input-wrap">
            <Input
              id="compare-keyword-search"
              type="text"
              placeholder="Search keywords"
              value={keywordSearch}
              onChange={(event) => setKeywordSearch(event.target.value)}
              aria-label="Search compare keywords"
            />
            <Button
              id="compare-keyword-scope"
              variant={showAllKeywords ? "outline" : "primary"}
              size="sm"
              type="button"
              onClick={() => setShowAllKeywords((v) => !v)}
            >
              {showAllKeywords ? "ALL" : "TRACKED BY ALL"}
            </Button>
          </div>
          <div className="compare-keyword-actions">
            <Button
              id="compare-keyword-select-all"
              variant="ghost"
              size="sm"
              type="button"
              disabled={!canAddMoreKeywords || filteredUniverseKeywords.length === 0}
              onClick={handleSelectAllVisible}
            >
              Select all visible
            </Button>
            <Button
              id="compare-keyword-clear"
              variant="ghost"
              size="sm"
              type="button"
              disabled={selectedKeywords.length === 0}
              onClick={handleClearKeywords}
            >
              Clear
            </Button>
            <Badge className="compare-limit-badge">
              {selectedKeywords.length} / {COMPARE_MAX_KEYWORDS} KEYWORDS
            </Badge>
          </div>
        </div>

        {universeError ? (
          <p className="compare-error">{universeError}</p>
        ) : null}

        <div className="compare-universe" role="list">
          {isUniverseLoading && !universe ? (
            <div className="compare-universe-empty">Loading keywords…</div>
          ) : filteredUniverseKeywords.length === 0 ? (
            <div className="compare-universe-empty">
              No keywords match. Try "ALL" or a different search.
            </div>
          ) : (
            filteredUniverseKeywords.map((kw) => {
              const isSelected = selectedKeywordSet.has(kw.keyword);
              return (
                <label
                  key={kw.keyword}
                  className={cx(
                    "compare-universe-row",
                    isSelected && "compare-universe-row--selected"
                  )}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => handleToggleKeyword(kw.keyword)}
                    disabled={
                      !isSelected &&
                      selectedKeywords.length >= COMPARE_MAX_KEYWORDS
                    }
                  />
                  <span className="compare-universe-kw">{kw.keyword}</span>
                  <span className="compare-universe-meta">
                    {kw.trackedCount}/{selectedAppIds.length} tracked
                  </span>
                  {kw.popularity != null ? (
                    <span className="compare-universe-pop">
                      pop {kw.popularity}
                    </span>
                  ) : null}
                </label>
              );
            })
          )}
        </div>
      </Card>

      {(() => {
        const matrixCard = (
      <Card
        className={cx(
          "compare-matrix-card",
          isMatrixFullscreen && "compare-matrix-card--fullscreen"
        )}
      >
        <button
          type="button"
          className="compare-matrix-fullscreen"
          aria-label={
            isMatrixFullscreen ? "Exit fullscreen" : "Expand matrix to fullscreen"
          }
          aria-pressed={isMatrixFullscreen}
          title={
            isMatrixFullscreen
              ? "Exit fullscreen (Esc)"
              : "View matrix fullscreen"
          }
          onClick={() => setIsMatrixFullscreen((value) => !value)}
        >
          {isMatrixFullscreen ? "⤡" : "⛶"}
        </button>
        {matrixError ? (
          <p className="compare-error">{matrixError}</p>
        ) : null}
        {selectedAppIds.length < COMPARE_MIN_APPS ? (
          <div className="compare-empty">
            Select at least {COMPARE_MIN_APPS} apps to start comparing.
          </div>
        ) : selectedKeywords.length === 0 ? (
          <div className="compare-empty">
            Pick at least one keyword to populate the matrix.
          </div>
        ) : isMatrixLoading && !matrix ? (
          <div className="compare-empty">Building matrix…</div>
        ) : !matrix || matrix.rows.length === 0 ? (
          <div className="compare-empty">
            No shared rank data yet. Try adding more keywords or toggling "ALL".
          </div>
        ) : (
          <div className="compare-matrix-wrap">
            <table className="compare-matrix">
              <thead>
                <tr>
                  <th
                    scope="col"
                    className={cx(
                      "compare-matrix-keyword-head",
                      sort.kind === "keyword" && "is-active"
                    )}
                  >
                    <button
                      type="button"
                      className="compare-sort-button"
                      onClick={() =>
                        toggleSort({ kind: "keyword", dir: "asc" })
                      }
                    >
                      Keyword
                      {renderHeaderSortArrow(
                        sort.kind === "keyword",
                        sort.dir
                      )}
                    </button>
                  </th>
                  <th
                    scope="col"
                    className={cx(
                      "compare-matrix-meta-head",
                      sort.kind === "popularity" && "is-active"
                    )}
                  >
                    <button
                      type="button"
                      className="compare-sort-button"
                      onClick={() =>
                        toggleSort({ kind: "popularity", dir: "desc" })
                      }
                    >
                      Popularity
                      {renderHeaderSortArrow(
                        sort.kind === "popularity",
                        sort.dir
                      )}
                    </button>
                  </th>
                  {matrix.apps.map((app) => {
                    const meta = appById.get(app.appId);
                    const iconUrl = meta
                      ? getIconUrl({
                          appId: meta.id,
                          name: meta.name,
                          icon: meta.icon,
                        })
                      : null;
                    return (
                      <th
                        key={app.appId}
                        scope="col"
                        className={cx(
                          "compare-matrix-app-head",
                          sort.kind === "rank" &&
                            sort.appId === app.appId &&
                            "is-active"
                        )}
                      >
                        <button
                          type="button"
                          className="compare-sort-button compare-matrix-app-head-button"
                          onClick={() =>
                            toggleSort({
                              kind: "rank",
                              appId: app.appId,
                              dir: "asc",
                            })
                          }
                        >
                          {iconUrl ? (
                            <img
                              className="compare-chip-icon"
                              src={iconUrl}
                              alt=""
                              loading="lazy"
                            />
                          ) : null}
                          <span className="compare-matrix-app-name">
                            {app.name}
                          </span>
                          {renderHeaderSortArrow(
                            sort.kind === "rank" && sort.appId === app.appId,
                            sort.dir
                          )}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row) => (
                  <tr key={row.normalizedKeyword}>
                    <th scope="row" className="compare-matrix-keyword-cell">
                      <span className="compare-matrix-keyword">
                        {row.keyword}
                      </span>
                      <button
                        type="button"
                        className="compare-matrix-remove"
                        aria-label={`Remove ${row.keyword}`}
                        onClick={() => handleRemoveKeyword(row.keyword)}
                      >
                        ×
                      </button>
                      <span className="compare-matrix-universe-meta">
                        {(() => {
                          const uni = universeById.get(row.normalizedKeyword);
                          if (!uni) return null;
                          return `${uni.trackedCount}/${selectedAppIds.length} tracked`;
                        })()}
                      </span>
                    </th>
                    <td className="compare-matrix-meta-cell">
                      {row.popularity != null ? row.popularity : "–"}
                    </td>
                    {row.cells.map((cell) => (
                      <td
                        key={cell.appId}
                        className={cx(
                          "compare-cell",
                          rankTintClass(cell.currentPosition)
                        )}
                        title={describeCell(cell, row.status === "researched")}
                        aria-label={describeCell(
                          cell,
                          row.status === "researched"
                        )}
                      >
                        <CompareCellContent cell={cell} row={row} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
        );
        return isMatrixFullscreen && typeof document !== "undefined"
          ? createPortal(matrixCard, document.body)
          : matrixCard;
      })()}
    </div>
  );
}
