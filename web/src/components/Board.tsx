import { useMemo, useRef, useState } from 'react';
import {
  DndContext,
  DragOverlay,
  MeasuringStrategy,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import type { BoardColumn, BugCard as Bug, ItemKind } from '../types';
import { levelColor, levelShort } from '../severity';

/** How much of a card's height (top and bottom) counts as "between cards". */
const EDGE_BAND = 0.3;

const cardId = (id: number) => `bug:${id}`;
const columnId = (key: string) => `col:${key}`;
const parseId = (raw: string) => {
  const [kind, value] = raw.split(':');
  return { kind, value };
};

interface DropIndicator {
  column: string;
  /** Index into the column as rendered, i.e. counting the dragged card itself. */
  renderIndex: number;
  /** Index the server should use, which counts the column without that card. */
  serverIndex: number;
}

interface Props {
  bugs: Bug[];
  columns: BoardColumn[];
  kinds: ItemKind[];
  canManage: boolean;
  onOpen: (id: number) => void;
  onMove: (id: number, status: string, index: number) => void;
  onMerge: (id: number, intoId: number) => void;
}

export function Board({ bugs, columns, kinds, canManage, onOpen, onMove, onMerge }: Props) {
  const kindOf = (key: string) => kinds.find((k) => k.key === key);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [mergeTarget, setMergeTarget] = useState<number | null>(null);
  const [indicator, setIndicator] = useState<DropIndicator | null>(null);

  // Read in dragEnd, where React state would still be a render behind.
  const live = useRef<{ merge: number | null; drop: DropIndicator | null }>({
    merge: null,
    drop: null,
  });

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const byColumn = useMemo(() => {
    const map = new Map<string, Bug[]>(columns.map((c) => [c.key, []]));
    for (const bug of bugs) {
      const list = map.get(bug.status);
      if (list) list.push(bug);
    }
    for (const list of map.values()) list.sort((a, b) => a.position - b.position);
    return map;
  }, [bugs, columns]);

  const active = activeId === null ? null : (bugs.find((b) => b.id === activeId) ?? null);

  /**
   * Hovering a blocked card answers "what is holding this up?" by dimming
   * everything that is not an answer. Only blocked cards do it — on anything
   * else there is nothing to point at — and never mid-drag, where dimming the
   * board would fight the thing being dragged.
   */
  const [hoveredId, setHoveredId] = useState<number | null>(null);

  const focused = useMemo(() => {
    if (hoveredId === null || activeId !== null) return null;
    const bug = bugs.find((b) => b.id === hoveredId);
    if (!bug || bug.blockedBy.length === 0) return null;
    return new Set<number>([bug.id, ...bug.blockedBy]);
  }, [hoveredId, activeId, bugs]);

  /**
   * A card's middle band means "merge with this one"; its top and bottom edges,
   * and any empty space, mean "drop into this column at this position". Without
   * the band split a full column would have nowhere left to drop *between*
   * cards, because every pixel of it belongs to a card.
   */
  const collisionDetection: CollisionDetection = ({ droppableContainers, pointerCoordinates }) => {
    if (!pointerCoordinates) return [];
    const { x, y } = pointerCoordinates;

    const containers = [...droppableContainers.values()];
    const inside = (rect: { left: number; right: number; top: number; bottom: number }) =>
      x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;

    for (const container of containers) {
      if (!String(container.id).startsWith('bug:')) continue;
      const rect = container.rect.current;
      if (!rect || !inside(rect)) continue;

      const band = rect.height * EDGE_BAND;
      if (y > rect.top + band && y < rect.bottom - band) {
        return [{ id: container.id }];
      }
      break; // on a card, but near its edge — fall through to the column
    }

    for (const container of containers) {
      if (!String(container.id).startsWith('col:')) continue;
      const rect = container.rect.current;
      if (rect && inside(rect)) return [{ id: container.id }];
    }

    return [];
  };

  function onDragStart(event: DragStartEvent) {
    const { value } = parseId(String(event.active.id));
    setActiveId(Number(value));
  }

  function onDragMove(event: DragMoveEvent) {
    const over = event.over;
    if (!over) {
      live.current = { merge: null, drop: null };
      setMergeTarget(null);
      setIndicator(null);
      return;
    }

    const { kind, value } = parseId(String(over.id));

    if (kind === 'bug') {
      const target = Number(value);
      const next = target === activeId ? null : target;
      live.current = { merge: next, drop: null };
      setMergeTarget(next);
      setIndicator(null);
      return;
    }

    // Over a column: work out where between the cards this would land, from the
    // dragged card's own centre rather than the pointer, so the indicator sits
    // where the card visually is.
    const column = value;
    const rect = event.active.rect.current.translated;
    const centre = rect ? rect.top + rect.height / 2 : 0;

    const cards = byColumn.get(column) ?? [];
    let renderIndex = cards.length;
    for (let i = 0; i < cards.length; i++) {
      if (cards[i].id === activeId) continue; // its slot is where it came from
      const node = document.querySelector<HTMLElement>(`[data-card="${cards[i].id}"]`);
      if (!node) continue;
      const box = node.getBoundingClientRect();
      if (centre < box.top + box.height / 2) {
        renderIndex = i;
        break;
      }
    }

    // The server renumbers a column that does not contain the dragged card, so
    // anything it used to sit in front of has shifted down by one.
    const from = cards.findIndex((b) => b.id === activeId);
    const serverIndex = from >= 0 && from < renderIndex ? renderIndex - 1 : renderIndex;

    const drop = { column, renderIndex, serverIndex };
    live.current = { merge: null, drop };
    setMergeTarget(null);
    setIndicator(drop);
  }

  function onDragEnd(event: DragEndEvent) {
    const draggedId = Number(parseId(String(event.active.id)).value);
    const { merge, drop } = live.current;

    setActiveId(null);
    setMergeTarget(null);
    setIndicator(null);
    live.current = { merge: null, drop: null };

    if (merge !== null && merge !== draggedId) {
      onMerge(draggedId, merge);
      return;
    }

    if (drop) {
      const bug = bugs.find((b) => b.id === draggedId);
      const cards = byColumn.get(drop.column) ?? [];
      const currentIndex = cards.findIndex((b) => b.id === draggedId);
      // A no-op drop back where it started should not write to the server.
      if (bug && bug.status === drop.column && currentIndex === drop.renderIndex) return;
      onMove(draggedId, drop.column, drop.serverIndex);
    }
  }

  function onDragCancel() {
    setActiveId(null);
    setMergeTarget(null);
    setIndicator(null);
    live.current = { merge: null, drop: null };
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      // Cards are measured continuously: the indicator changes the column's
      // height as it moves, and stale rects would aim the merge band at the
      // wrong card.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={onDragStart}
      onDragMove={onDragMove}
      onDragEnd={onDragEnd}
      onDragCancel={onDragCancel}
    >
      <div className="board">
        {columns.map((column) => (
          <Column
            key={column.key}
            column={column}
            bugs={byColumn.get(column.key) ?? []}
            canManage={canManage}
            activeId={activeId}
            mergeTarget={mergeTarget}
            indicator={indicator?.column === column.key ? indicator.renderIndex : null}
            kindOf={kindOf}
            focused={focused}
            onHover={setHoveredId}
            onOpen={onOpen}
          />
        ))}
      </div>

      <DragOverlay dropAnimation={null} className="drag-overlay">
        {active ? (
          <div
            className="card"
            style={
              { '--sev-color': levelColor(kindOf(active.kind), active.severity) } as React.CSSProperties
            }
          >
            <CardFace bug={active} kind={kindOf(active.kind)} />
          </div>
        ) : null}
      </DragOverlay>

      {active ? (
        <div className="drag-hint">
          {mergeTarget !== null ? (
            <>
              Drop to merge <b>#{active.id}</b> into <b>#{mergeTarget}</b> as a duplicate
            </>
          ) : (
            <>
              Drop on a column to move · drop on the middle of a card to <b>merge</b>
            </>
          )}
        </div>
      ) : null}
    </DndContext>
  );
}

// ---------------------------------------------------------------- a column

function Column({
  column,
  bugs,
  canManage,
  activeId,
  mergeTarget,
  indicator,
  kindOf,
  focused,
  onHover,
  onOpen,
}: {
  column: BoardColumn;
  bugs: Bug[];
  canManage: boolean;
  activeId: number | null;
  mergeTarget: number | null;
  indicator: number | null;
  kindOf: (key: string) => ItemKind | undefined;
  focused: Set<number> | null;
  onHover: (id: number | null) => void;
  onOpen: (id: number) => void;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId(column.key) });

  const style = { '--col-color': column.color } as React.CSSProperties;

  return (
    <section
      className={`column${isOver && activeId !== null ? ' drop-active' : ''}`}
      style={style}
      ref={setNodeRef}
    >
      <header className="column-head">
        <span className="dot" />
        <h2>{column.label}</h2>
        <span className="count">{bugs.length}</span>
      </header>

      <div className="column-body">
        {bugs.length === 0 && indicator === null ? (
          <div className="column-empty">
            {column.intake ? 'Nothing waiting to be triaged' : 'Empty'}
          </div>
        ) : null}

        {/*
          The card being dragged stays in the list, dimmed. Pulling it out would
          reflow every card below it mid-drag, and the drop target would then be
          measured against positions that no longer exist.
        */}
        {bugs.map((bug, i) => (
          <div key={bug.id}>
            {indicator === i ? <DropLine color={column.color} /> : null}
            <DraggableCard
              bug={bug}
              canManage={canManage}
              isMergeTarget={mergeTarget === bug.id}
              kind={kindOf(bug.kind)}
              dimmed={focused !== null && !focused.has(bug.id)}
              onHover={onHover}
              onOpen={onOpen}
            />
          </div>
        ))}

        {indicator !== null && indicator >= bugs.length ? <DropLine color={column.color} /> : null}
      </div>
    </section>
  );
}

function DropLine({ color }: { color: string }) {
  return (
    <div
      style={{
        height: 2,
        background: color,
        borderRadius: 2,
        margin: '3px 0',
        boxShadow: `0 0 6px ${color}`,
      }}
    />
  );
}

// ------------------------------------------------------------------ a card

function DraggableCard({
  bug,
  canManage,
  isMergeTarget,
  kind,
  dimmed,
  onHover,
  onOpen,
}: {
  bug: Bug;
  canManage: boolean;
  isMergeTarget: boolean;
  kind: ItemKind | undefined;
  dimmed: boolean;
  onHover: (id: number | null) => void;
  onOpen: (id: number) => void;
}) {
  const draggable = useDraggable({ id: cardId(bug.id), disabled: !canManage });
  const droppable = useDroppable({ id: cardId(bug.id), disabled: !canManage });

  const setRef = (node: HTMLElement | null) => {
    draggable.setNodeRef(node);
    droppable.setNodeRef(node);
  };

  return (
    <div
      ref={setRef}
      data-card={bug.id}
      className={
        'card' +
        (draggable.isDragging ? ' dragging' : '') +
        (isMergeTarget ? ' merge-target' : '') +
        (bug.blockedBy.length ? ' is-blocked' : '') +
        (dimmed ? ' dimmed' : '')
      }
      style={{ '--sev-color': levelColor(kind, bug.severity) } as React.CSSProperties}
      onClick={() => onOpen(bug.id)}
      onMouseEnter={() => onHover(bug.id)}
      onMouseLeave={() => onHover(null)}
      {...(canManage ? draggable.listeners : {})}
      {...(canManage ? draggable.attributes : {})}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(bug.id);
        }
      }}
    >
      <CardFace bug={bug} kind={kind} />
    </div>
  );
}

/** The card's contents, shared by the board and the drag overlay. */
function CardFace({ bug, kind }: { bug: Bug; kind: ItemKind | undefined }) {
  return (
    <>
      <div className="card-title">{bug.title}</div>
      <div className="card-meta">
        <span className="id">#{bug.id}</span>
        <span>{levelShort(kind, bug.severity)}</span>
        <span className="grow" />
        {bug.blockedBy.length ? (
          <span
            className="pill blocked"
            title={`Blocked by ${bug.blockedBy.map((id) => '#' + id).join(', ')}`}
          >
            blocked
            {bug.blockedBy.length > 1 ? ` ×${bug.blockedBy.length}` : ''}
          </span>
        ) : null}
        {bug.occurrences > 1 ? (
          <span className="pill hits" title={`Reported automatically ${bug.occurrences} times`}>
            ↻ {bug.occurrences.toLocaleString()}
          </span>
        ) : null}
        {bug.duplicateCount > 0 ? (
          <span className="pill dup" title={`${bug.duplicateCount} merged duplicate(s)`}>
            ×{bug.duplicateCount + 1}
          </span>
        ) : null}
        {bug.attachmentCount > 0 ? <span title="attachments">▣ {bug.attachmentCount}</span> : null}
        {bug.commentCount > 0 ? <span title="comments">◇ {bug.commentCount}</span> : null}
        {bug.assignee ? (
          <span className={bug.assignee.isBot ? 'pill bot' : 'pill'} title="assignee">
            {bug.assignee.name.split(' ')[0]}
          </span>
        ) : null}
        {kind ? (
          <span className="kind-emoji" title={kind.label} aria-label={kind.label} role="img">
            {kind.emoji}
          </span>
        ) : null}
      </div>
    </>
  );
}
