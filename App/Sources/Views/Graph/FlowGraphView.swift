import SwiftUI

// MARK: - FlowGraphView
//
// A scrollable node-link diagram of the workspace's tickets. Epics sit at the
// top as "umbrella" nodes with their child tickets flowing beneath them
// (the `parent_id` hierarchy), and cross-ticket relations (blocks / relates-to
// / duplicates) are overlaid as dashed connectors. Tapping any node opens the
// same `TicketDetailView` sheet the board uses.

struct FlowGraphView: View {

    @Environment(AppStore.self) private var store

    @State private var selectedTicket: Ticket? = nil
    @State private var layout: FlowGraphLayout = .empty
    @State private var relationEdges: [RelationEdge] = []
    @State private var eventStream: EventStream?
    /// The ticket-id set the current `relationEdges` were fetched for, so we
    /// only re-fan-out the relation requests when the graph's membership
    /// actually changes — not on every status tweak coming over SSE.
    @State private var loadedRelationIds: Set<String> = []

    @State private var scale: CGFloat = 1.0
    @GestureState private var pinch: CGFloat = 1.0
    /// Viewport width the masonry grid packs into, from a `GeometryReader`.
    @State private var availableWidth: CGFloat = 0

    /// Tapped node whose connections are spotlighted (everything else dims).
    /// A second tap on the same node opens its detail.
    @State private var highlightedId: String? = nil
    /// Collapsed epic ids, persisted across launches as a comma-joined list.
    @AppStorage("scope.graphCollapsedIDs") private var collapsedRaw: String = ""

    private var collapsedIds: Set<String> {
        Set(collapsedRaw.split(separator: ",").map(String.init))
    }

    /// The highlighted node plus its direct neighbours (so they stay lit).
    private var connectedIds: Set<String> {
        guard let h = highlightedId else { return [] }
        var ids: Set<String> = [h]
        for e in layout.parentEdges {
            if e.from == h { ids.insert(e.to) }
            if e.to == h { ids.insert(e.from) }
        }
        for e in relationEdges {
            if e.from == h { ids.insert(e.to) }
            if e.to == h { ids.insert(e.from) }
        }
        return ids
    }

    private static let minScale: CGFloat = 0.4
    private static let maxScale: CGFloat = 2.5

    private var workspace: Workspace? { store.selectedWorkspace }

    var body: some View {
        content
            .navigationTitle("Graph")
        .sheet(item: $selectedTicket) { ticket in
            NavigationStack {
                TicketDetailView(ticket: ticket)
            }
        }
        .task(id: workspace?.id) {
            guard workspace != nil else { return }
            // Drop the relation cache for the new workspace: it's keyed by
            // ticket-id set, and two workspaces can share ids (each numbers from
            // 1), which would otherwise reuse the previous workspace's edges.
            loadedRelationIds = []
            relationEdges = []
            if store.tickets.isEmpty { await store.loadTickets() }
            rebuildLayout()
            await loadRelations()
            startEventStream()
        }
        .onChange(of: store.tickets) { _, _ in
            rebuildLayout()
            Task { await loadRelations() }
        }
        .onChange(of: store.relationsVersion) { _, _ in
            // relation.added/removed don't change the ticket list, so force a
            // re-fetch past the id-set guard to refresh the drawn connectors.
            Task { await loadRelations(force: true) }
        }
        .onDisappear { eventStream?.disconnect() }
    }

    // MARK: Content state

    @ViewBuilder
    private var content: some View {
        if workspace == nil {
            ContentUnavailableView(
                "No Workspace Selected",
                systemImage: "point.3.connected.trianglepath.dotted",
                description: Text("Select a workspace from the menu.")
            )
        } else if store.isLoading && store.tickets.isEmpty {
            ProgressView("Loading…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if store.tickets.isEmpty {
            ContentUnavailableView(
                "No Tickets",
                systemImage: "point.3.connected.trianglepath.dotted",
                description: Text("Tickets and their relationships will appear here as a graph.")
            )
        } else {
            GeometryReader { geo in
                graphContent
                    .onAppear { applyWidth(geo.size.width) }
                    .onChange(of: geo.size.width) { _, newWidth in applyWidth(newWidth) }
            }
        }
    }

    // MARK: Graph canvas

    private var graphContent: some View {
        let effectiveScale = min(max(scale * pinch, Self.minScale), Self.maxScale)
        let scaledSize = CGSize(
            width: layout.size.width * effectiveScale,
            height: layout.size.height * effectiveScale
        )

        let connected = connectedIds

        return ScrollView([.horizontal, .vertical], showsIndicators: true) {
            ZStack(alignment: .topLeading) {
                FlowGraphEdges(
                    parentEdges: layout.parentEdges,
                    relationEdges: relationEdges,
                    positions: layout.positions,
                    clusterRects: layout.clusterRects,
                    highlightedId: highlightedId
                )
                .frame(width: layout.size.width, height: layout.size.height)
                // Tapping empty canvas clears the highlight.
                .contentShape(Rectangle())
                .onTapGesture { withAnimation(.easeInOut(duration: 0.15)) { highlightedId = nil } }

                ForEach(layout.nodes) { node in
                    FlowGraphNodeView(
                        ticket: node.ticket,
                        childCount: node.childCount,
                        collapsed: collapsedIds.contains(node.ticket.id),
                        dimmed: highlightedId != nil && !connected.contains(node.ticket.id),
                        selected: highlightedId == node.ticket.id,
                        onTap: { tapNode(node.ticket) },
                        onToggleCollapse: { toggleCollapse(node.ticket.id) }
                    )
                    .frame(width: FlowGraphLayout.nodeWidth, height: FlowGraphLayout.nodeHeight)
                    .position(node.center)
                }
            }
            .frame(width: layout.size.width, height: layout.size.height)
            .scaleEffect(effectiveScale, anchor: .topLeading)
            // The scaled content reports its *unscaled* footprint to the
            // ScrollView, so wrap it in a frame of the true scaled size to make
            // scrolling cover the whole diagram at any zoom level.
            .frame(width: scaledSize.width, height: scaledSize.height, alignment: .topLeading)
            .padding(.trailing, 48)
            .padding(.bottom, 48)
        }
        .gesture(magnifyGesture)
        // Single floating controls overlay (zoom + legend), pinned to the
        // ScrollView's frame so it never scrolls with the diagram.
        .overlay(alignment: .bottomTrailing) { controlsOverlay }
    }

    private var magnifyGesture: some Gesture {
        MagnifyGesture()
            .updating($pinch) { value, state, _ in state = value.magnification }
            .onEnded { value in
                scale = min(max(scale * value.magnification, Self.minScale), Self.maxScale)
            }
    }

    // MARK: Controls overlay (zoom + legend)

    private var controlsOverlay: some View {
        VStack(spacing: 0) {
            HStack(spacing: 2) {
                zoomButton("minus", disabled: scale <= Self.minScale + 0.001) {
                    setScale(scale - 0.2)
                }
                zoomButton("arrow.up.left.and.down.right.magnifyingglass",
                           disabled: abs(scale - 1.0) < 0.001) {
                    setScale(1.0)
                }
                zoomButton("plus", disabled: scale >= Self.maxScale - 0.001) {
                    setScale(scale + 0.2)
                }
            }
            .padding(5)

            if legendHasContent {
                Divider()
                legendRows
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 11)
                    .padding(.vertical, 9)
            }
        }
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(.quaternary, lineWidth: 0.5)
        )
        .padding(16)
    }

    private func zoomButton(_ system: String, disabled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 14, weight: .medium))
                .frame(width: 30, height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(disabled ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
        .disabled(disabled)
    }

    private func setScale(_ value: CGFloat) {
        withAnimation(.easeInOut(duration: 0.2)) {
            scale = min(max(value, Self.minScale), Self.maxScale)
        }
    }

    // MARK: Legend

    private var legendHasContent: Bool {
        !layout.parentEdges.isEmpty || !legendRelationKinds.isEmpty
    }

    private var legendRows: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !layout.parentEdges.isEmpty {
                legendRow(color: .secondary, dashed: false, label: "Epic → ticket")
            }
            ForEach(legendRelationKinds, id: \.self) { kind in
                legendRow(color: kind.graphColor, dashed: true, label: kind.legendLabel)
            }
        }
        .font(.caption2)
    }

    /// The distinct relation kinds present, collapsed to their forward label
    /// (so `blocks`/`blocked_by` show once), in a stable display order.
    private var legendRelationKinds: [RelationType] {
        let present = Set(relationEdges.map(\.type))
        return [.blocks, .relates_to, .duplicates].filter { kind in
            present.contains(kind) || present.contains(kind.inverse)
        }
    }

    private func legendRow(color: Color, dashed: Bool, label: String) -> some View {
        HStack(spacing: 8) {
            LegendDash(color: color, dashed: dashed)
                .frame(width: 22, height: 2)
            Text(label)
                .foregroundStyle(.secondary)
        }
    }

    // MARK: Data

    private func rebuildLayout() {
        layout = FlowGraphLayout.build(
            tickets: store.tickets,
            availableWidth: availableWidth > 1 ? availableWidth : 393,
            collapsed: collapsedIds
        )
    }

    /// First tap spotlights a node's connections; a second tap on the same node
    /// opens its detail.
    private func tapNode(_ ticket: Ticket) {
        if highlightedId == ticket.id {
            selectedTicket = ticket
        } else {
            withAnimation(.easeInOut(duration: 0.15)) { highlightedId = ticket.id }
        }
    }

    private func toggleCollapse(_ id: String) {
        var ids = collapsedIds
        if ids.contains(id) { ids.remove(id) } else { ids.insert(id) }
        collapsedRaw = ids.sorted().joined(separator: ",")
        if highlightedId != nil { highlightedId = nil }
        rebuildLayout()
    }

    /// Re-pack the grid when the viewport width changes (rotation, split view,
    /// first layout pass).
    private func applyWidth(_ width: CGFloat) {
        guard width > 1, abs(width - availableWidth) > 0.5 else { return }
        availableWidth = width
        rebuildLayout()
    }

    /// Re-fetch the relation overlay. By default this is skipped when the graph
    /// membership (ticket-id set) is unchanged — a status-only SSE update moves
    /// nothing relation-relevant. Pass `force: true` for relation.added/removed
    /// events, where the id set is identical but the edges genuinely changed.
    private func loadRelations(force: Bool = false) async {
        let ids = Set(store.tickets.map(\.id))
        guard !ids.isEmpty else {
            relationEdges = []
            loadedRelationIds = []
            return
        }
        guard force || ids != loadedRelationIds else { return }
        let edges = await store.loadRelationEdges(for: store.tickets.map(\.id))
        // Drop any edge whose endpoints aren't both currently placed.
        relationEdges = edges.filter {
            layout.positions[$0.from] != nil && layout.positions[$0.to] != nil
        }
        loadedRelationIds = ids
    }

    // MARK: - Event stream

    /// The Graph tab carries its own SSE stream (the Board tab disconnects its
    /// own on disappear), so the diagram stays live: ticket events update the
    /// shared store (driving a layout rebuild + relation reload), and relation
    /// events bump `relationsVersion` to force a relation re-fetch.
    private func startEventStream() {
        guard let client = store.client else { return }
        eventStream?.disconnect()

        let stream = EventStream(baseURL: client.baseURL)
        let storeRef = store
        stream.onEvent = { event in
            switch event {
            case .ticketCreated(let ticket):
                if !storeRef.tickets.contains(where: { $0.id == ticket.id }) {
                    storeRef.tickets.append(ticket)
                }
            case .ticketUpdated(let ticket):
                if let idx = storeRef.tickets.firstIndex(where: { $0.id == ticket.id }) {
                    storeRef.tickets[idx] = ticket
                } else {
                    storeRef.tickets.append(ticket)
                }
            case .ticketDeleted(let ticketId):
                storeRef.tickets.removeAll { $0.id == ticketId }
            case .relationsChanged:
                storeRef.relationsVersion &+= 1
            }
        }
        eventStream = stream
        stream.connect(workspaceId: store.selectedWorkspace?.id)
    }
}

// MARK: - Legend dash

private struct LegendDash: View {
    let color: Color
    let dashed: Bool

    var body: some View {
        GeometryReader { geo in
            Path { path in
                let y = geo.size.height / 2
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: geo.size.width, y: y))
            }
            .stroke(color, style: StrokeStyle(lineWidth: 2, dash: dashed ? [4, 3] : []))
        }
    }
}

// MARK: - Node view

private struct FlowGraphNodeView: View {
    let ticket: Ticket
    let childCount: Int
    let collapsed: Bool
    let dimmed: Bool
    let selected: Bool
    let onTap: () -> Void
    let onToggleCollapse: () -> Void

    private var isEpic: Bool { ticket.type == .epic }
    private var collapsible: Bool { childCount > 0 }

    private var borderColor: Color {
        if selected { return .accentColor }
        if isEpic {
            return Color(hue: graphHue(ticket.id), saturation: 0.55, brightness: 0.7).opacity(0.6)
        }
        return Color.black.opacity(0.06)
    }

    var body: some View {
        Button(action: onTap) {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    if collapsible {
                        Button(action: onToggleCollapse) {
                            Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                                .font(.caption2.weight(.bold))
                                .foregroundStyle(.secondary)
                                .frame(width: 14, height: 14)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                    }
                    Image(systemName: ticket.type.graphIcon)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(ticket.type.graphTint)
                    Text(ticket.id)
                        .font(.caption2.weight(.semibold))
                        .monospaced()
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    if isEpic && childCount > 0 {
                        Text("\(childCount)")
                            .font(.caption2.weight(.bold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 1)
                            .background(ticket.type.graphTint.opacity(0.18), in: Capsule())
                            .foregroundStyle(ticket.type.graphTint)
                    }
                    Circle()
                        .fill(ticket.status.graphAccent)
                        .frame(width: 8, height: 8)
                }

                Text(ticket.title)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)

                Spacer(minLength: 0)
            }
            .padding(10)
            .frame(
                width: FlowGraphLayout.nodeWidth,
                height: FlowGraphLayout.nodeHeight,
                alignment: .topLeading
            )
            .background(
                Color(uiColor: .secondarySystemBackground),
                in: RoundedRectangle(cornerRadius: 12, style: .continuous)
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(borderColor, lineWidth: selected ? 2 : (isEpic ? 1.5 : 1))
            )
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(.plain)
        .opacity(dimmed ? 0.22 : 1)
        .shadow(color: selected ? Color.accentColor.opacity(0.35) : .clear, radius: 6)
    }
}

// MARK: - Edges

private struct FlowGraphEdges: View {
    let parentEdges: [FlowGraphLayout.Edge]
    let relationEdges: [RelationEdge]
    let positions: [String: CGPoint]
    let clusterRects: [FlowGraphLayout.ClusterRect]
    let highlightedId: String?

    var body: some View {
        Canvas { context, _ in
            // Per-epic tinted umbrellas behind everything else.
            for cluster in clusterRects where cluster.ticket.type == .epic {
                let tint = Color(hue: graphHue(cluster.ticket.id), saturation: 0.55, brightness: 0.72)
                let shape = Path(roundedRect: cluster.rect, cornerRadius: 18, style: .continuous)
                context.fill(shape, with: .color(tint.opacity(0.08)))
                context.stroke(shape, with: .color(tint.opacity(0.30)), lineWidth: 1)
            }

            let halfHeight = FlowGraphLayout.nodeHeight / 2

            // Epic → ticket hierarchy: smooth vertical S-curves fanning to children.
            for edge in parentEdges {
                guard let p = positions[edge.from], let c = positions[edge.to] else { continue }
                let lit = isLit(edge.from, edge.to)
                let start = CGPoint(x: p.x, y: p.y + halfHeight)
                let end = CGPoint(x: c.x, y: c.y - halfHeight)
                let midY = (start.y + end.y) / 2
                var path = Path()
                path.move(to: start)
                path.addCurve(
                    to: end,
                    control1: CGPoint(x: start.x, y: midY),
                    control2: CGPoint(x: end.x, y: midY)
                )
                context.stroke(path, with: .color(.secondary.opacity(lit ? 0.45 : 0.07)), lineWidth: 1.6)
            }

            // Cross-ticket relations: gently curved, dashed, colour-coded.
            for edge in relationEdges {
                guard let a = positions[edge.from], let b = positions[edge.to] else { continue }
                let lit = isLit(edge.from, edge.to)
                let color = edge.type.graphColor.opacity(lit ? 0.85 : 0.06)
                let control = Self.arcControl(a, b)
                var path = Path()
                path.move(to: a)
                path.addQuadCurve(to: b, control: control)
                context.stroke(path, with: .color(color),
                               style: StrokeStyle(lineWidth: 1.6, dash: [6, 4]))
                if edge.type.isDirectional {
                    Self.drawArrowHead(in: &context, control: control, to: b, color: color)
                }
            }
        }
    }

    /// An edge stays lit unless a node is spotlighted and this edge isn't on it.
    private func isLit(_ from: String, _ to: String) -> Bool {
        guard let h = highlightedId else { return true }
        return from == h || to == h
    }

    /// Control point for a gently bowed quadratic between two node centres.
    private static func arcControl(_ a: CGPoint, _ b: CGPoint) -> CGPoint {
        let mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2
        let dx = b.x - a.x, dy = b.y - a.y
        let len = max(hypot(dx, dy), 1)
        let bow = min(max(len * 0.12, 18), 70)
        return CGPoint(x: mx + (-dy / len) * bow, y: my + (dx / len) * bow)
    }

    /// Arrowhead at `to`, oriented along the curve's exit tangent (control → to).
    private static func drawArrowHead(
        in context: inout GraphicsContext,
        control: CGPoint,
        to b: CGPoint,
        color: Color
    ) {
        let dx = b.x - control.x
        let dy = b.y - control.y
        let length = max(hypot(dx, dy), 0.0001)
        let ux = dx / length
        let uy = dy / length
        let inset = FlowGraphLayout.nodeHeight / 2 + 4
        let tip = CGPoint(x: b.x - ux * inset, y: b.y - uy * inset)
        let angle = atan2(uy, ux)
        let wing: CGFloat = 8
        let spread: CGFloat = .pi / 7
        let left = CGPoint(
            x: tip.x - cos(angle - spread) * wing,
            y: tip.y - sin(angle - spread) * wing
        )
        let right = CGPoint(
            x: tip.x - cos(angle + spread) * wing,
            y: tip.y - sin(angle + spread) * wing
        )
        var head = Path()
        head.move(to: left)
        head.addLine(to: tip)
        head.addLine(to: right)
        context.stroke(head, with: .color(color), lineWidth: 1.8)
    }
}

/// Deterministic 0–1 hue from a ticket id, so each epic keeps a stable tint.
private func graphHue(_ id: String) -> Double {
    var h: UInt32 = 0
    for scalar in id.unicodeScalars { h = h &* 31 &+ scalar.value }
    return Double(h % 360) / 360.0
}

// MARK: - Layout engine

/// Layout of epic clusters. Each root (epic or parentless ticket) plus its
/// descendants becomes a compact cluster laid out recursively: a node sits on
/// top with its children fanned into a grid of 1–3 columns beneath it (more
/// columns on wider screens / bigger epics). Collapsed nodes hide their
/// children. Clusters flow left-to-right and wrap into rows to fit the viewport.
/// Cross-relations don't influence positions — they're overlaid afterwards.
struct FlowGraphLayout {

    struct PlacedNode: Identifiable {
        let ticket: Ticket
        let center: CGPoint
        let childCount: Int
        var id: String { ticket.id }
    }

    struct Edge {
        let from: String
        let to: String
    }

    struct ClusterRect: Identifiable {
        let ticket: Ticket
        let rect: CGRect
        var id: String { ticket.id }
    }

    let nodes: [PlacedNode]
    let positions: [String: CGPoint]
    let parentEdges: [Edge]
    let clusterRects: [ClusterRect]
    let size: CGSize

    static let nodeWidth: CGFloat = 210
    static let nodeHeight: CGFloat = 78
    private static let parentGap: CGFloat = 30   // node → its children area
    private static let childVGap: CGFloat = 14   // between stacked child blocks
    private static let innerGap: CGFloat = 18    // between child columns
    private static let clusterPad: CGFloat = 16  // inside a cluster's tint box
    private static let clusterGap: CGFloat = 22  // between clusters in a row
    private static let rowGap: CGFloat = 26      // between rows of clusters
    private static let padding: CGFloat = 24

    static let empty = FlowGraphLayout(
        nodes: [], positions: [:], parentEdges: [], clusterRects: [],
        size: CGSize(width: 1, height: 1)
    )

    private struct LocalNode {
        let ticket: Ticket
        let lx: CGFloat
        let ly: CGFloat
        let childCount: Int
    }
    private struct Block {
        let nodes: [LocalNode]
        let w: CGFloat
        let h: CGFloat
    }

    static func build(tickets: [Ticket], availableWidth: CGFloat, collapsed: Set<String>) -> FlowGraphLayout {
        guard !tickets.isEmpty else { return .empty }

        let avail = max(availableWidth - padding * 2, nodeWidth)
        let byId = Dictionary(tickets.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        var childrenOf: [String: [Ticket]] = [:]
        for ticket in tickets {
            if let parentId = ticket.parentId, byId[parentId] != nil {
                childrenOf[parentId, default: []].append(ticket)
            }
        }
        for key in childrenOf.keys { childrenOf[key]?.sort(by: Self.order) }

        // How many columns to fan a node's children into.
        func childCols(_ n: Int) -> Int {
            let byWidth = avail >= 1100 ? 3 : avail >= 680 ? 2 : 1
            let byCount = n > 12 ? 3 : n > 6 ? 2 : 1
            return max(1, min(byWidth, byCount))
        }

        // Recursively lay a node + its visible descendants out in block-local
        // coords. `visited` guards against pathological parent-id cycles.
        var visited = Set<String>()
        func swallow(_ ticket: Ticket) {
            visited.insert(ticket.id)
            for child in childrenOf[ticket.id] ?? [] { swallow(child) }
        }
        func layoutBlock(_ node: Ticket) -> Block {
            visited.insert(node.id)
            let kids = childrenOf[node.id] ?? []
            if kids.isEmpty || collapsed.contains(node.id) {
                // Collapsed: mark hidden descendants visited so the cycle-recovery
                // pass below doesn't resurrect them as their own clusters.
                for child in kids { swallow(child) }
                return Block(
                    nodes: [LocalNode(ticket: node, lx: nodeWidth / 2, ly: nodeHeight / 2, childCount: kids.count)],
                    w: nodeWidth, h: nodeHeight
                )
            }
            let blocks = kids.map(layoutBlock)
            let cols = childCols(blocks.count)
            let colW = max(nodeWidth, blocks.map(\.w).max() ?? nodeWidth)
            var colH = [CGFloat](repeating: 0, count: cols)
            var placements: [(block: Block, col: Int, yoff: CGFloat)] = []
            for block in blocks {
                var col = 0
                for j in 1..<cols where colH[j] < colH[col] { col = j }
                placements.append((block, col, colH[col]))
                colH[col] += block.h + childVGap
            }
            let childrenW = CGFloat(cols) * colW + CGFloat(cols - 1) * innerGap
            let childrenH = (colH.max() ?? 0) - childVGap
            let blockW = max(nodeWidth, childrenW)
            let childrenX0 = (blockW - childrenW) / 2
            let childrenY0 = nodeHeight + parentGap
            var local = [LocalNode(ticket: node, lx: blockW / 2, ly: nodeHeight / 2, childCount: kids.count)]
            for p in placements {
                let bx = childrenX0 + CGFloat(p.col) * (colW + innerGap) + (colW - p.block.w) / 2
                let by = childrenY0 + p.yoff
                for cn in p.block.nodes {
                    local.append(LocalNode(ticket: cn.ticket, lx: bx + cn.lx, ly: by + cn.ly, childCount: cn.childCount))
                }
            }
            return Block(nodes: local, w: blockW, h: childrenY0 + childrenH)
        }

        // Roots: no parent, or a parent that isn't loaded. Epics first.
        let roots = tickets
            .filter { ticket in
                guard let parentId = ticket.parentId else { return true }
                return byId[parentId] == nil
            }
            .sorted(by: Self.order)
        var clusters: [Block] = roots.map(layoutBlock)
        for ticket in tickets where !visited.contains(ticket.id) {
            clusters.append(layoutBlock(ticket))
        }

        // Flow clusters left-to-right, wrapping into rows that fit the viewport.
        var positions: [String: CGPoint] = [:]
        var placed: [PlacedNode] = []
        var clusterRects: [ClusterRect] = []
        var curX = padding
        var rowY = padding
        var rowMaxH: CGFloat = 0
        var maxRight = padding

        for cluster in clusters {
            let boxW = cluster.w + clusterPad * 2
            let boxH = cluster.h + clusterPad * 2
            if curX > padding && curX + boxW > padding + avail {
                rowY += rowMaxH + rowGap
                curX = padding
                rowMaxH = 0
            }
            let ox = curX + clusterPad
            let oy = rowY + clusterPad
            clusterRects.append(ClusterRect(
                ticket: cluster.nodes[0].ticket,
                rect: CGRect(x: curX, y: rowY, width: boxW, height: boxH)
            ))
            for node in cluster.nodes {
                let center = CGPoint(x: ox + node.lx, y: oy + node.ly)
                positions[node.ticket.id] = center
                placed.append(PlacedNode(ticket: node.ticket, center: center, childCount: node.childCount))
            }
            curX += boxW + clusterGap
            rowMaxH = max(rowMaxH, boxH)
            maxRight = max(maxRight, curX - clusterGap)
        }

        var parentEdges: [Edge] = []
        for node in placed {
            for child in childrenOf[node.ticket.id] ?? [] where positions[child.id] != nil {
                parentEdges.append(Edge(from: node.ticket.id, to: child.id))
            }
        }

        return FlowGraphLayout(
            nodes: placed,
            positions: positions,
            parentEdges: parentEdges,
            clusterRects: clusterRects,
            size: CGSize(width: max(maxRight + padding, 1), height: max(rowY + rowMaxH + padding, 1))
        )
    }

    /// Deterministic sibling/root ordering: epics first, then by creation time,
    /// then id — so the diagram doesn't reshuffle between renders.
    private static func order(_ a: Ticket, _ b: Ticket) -> Bool {
        if a.type != b.type { return a.type.graphRank < b.type.graphRank }
        if a.createdAt != b.createdAt { return a.createdAt < b.createdAt }
        return a.id < b.id
    }
}

// MARK: - Drawing helpers

private extension TicketType {
    var graphIcon: String {
        switch self {
        case .story: "bookmark.fill"
        case .bug:   "ant.fill"
        case .epic:  "bolt.fill"
        }
    }

    var graphTint: Color {
        switch self {
        case .story: .blue
        case .bug:   .red
        case .epic:  .purple
        }
    }

    var graphRank: Int {
        switch self {
        case .epic:  0
        case .story: 1
        case .bug:   2
        }
    }
}

private extension TicketStatus {
    var graphAccent: Color {
        switch self {
        case .backlog:     .secondary
        case .todo:        .blue
        case .in_progress: .orange
        case .in_review:   .purple
        case .done:        .green
        case .cancelled:   .gray
        }
    }
}

extension RelationType {
    var graphColor: Color {
        switch self {
        case .blocks, .blocked_by:       .red
        case .relates_to:                .blue
        case .duplicates, .duplicate_of: .purple
        }
    }

    /// Directional links (blocks / duplicates) get an arrowhead; `relates_to`
    /// is symmetric and gets none.
    var isDirectional: Bool {
        switch self {
        case .relates_to: false
        default:          true
        }
    }

    var inverse: RelationType {
        switch self {
        case .blocks:        .blocked_by
        case .blocked_by:    .blocks
        case .relates_to:    .relates_to
        case .duplicates:    .duplicate_of
        case .duplicate_of:  .duplicates
        }
    }

    var legendLabel: String {
        switch self {
        case .blocks, .blocked_by:       "Blocks"
        case .relates_to:                "Relates to"
        case .duplicates, .duplicate_of: "Duplicates"
        }
    }
}

// MARK: - Preview

#Preview {
    let store: AppStore = {
        let store = AppStore()
        let now = Date.now
        store.tickets = [
            Ticket(id: "SCP-1", title: "Realtime sync epic", type: .epic, status: .in_progress,
                   priority: .high, description: nil, parentId: nil, assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-9000), updatedAt: now),
            Ticket(id: "SCP-2", title: "WebSocket transport", type: .story, status: .done,
                   priority: .high, description: nil, parentId: "SCP-1", assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-8000), updatedAt: now),
            Ticket(id: "SCP-3", title: "Reconnect with backoff", type: .story, status: .in_progress,
                   priority: .medium, description: nil, parentId: "SCP-1", assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-7000), updatedAt: now),
            Ticket(id: "SCP-4", title: "Dropped-frame crash", type: .bug, status: .todo,
                   priority: .urgent, description: nil, parentId: "SCP-1", assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-6000), updatedAt: now),
            Ticket(id: "SCP-5", title: "Onboarding epic", type: .epic, status: .backlog,
                   priority: .medium, description: nil, parentId: nil, assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-5000), updatedAt: now),
            Ticket(id: "SCP-6", title: "Pairing screen", type: .story, status: .in_review,
                   priority: .medium, description: nil, parentId: "SCP-5", assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-4000), updatedAt: now),
            Ticket(id: "SCP-7", title: "Standalone chore", type: .story, status: .backlog,
                   priority: .low, description: nil, parentId: nil, assignee: nil, labels: [],
                   createdAt: now.addingTimeInterval(-3000), updatedAt: now),
        ]
        return store
    }()
    NavigationStack {
        FlowGraphView()
    }
    .environment(store)
}

// Epics are full nodes in the relation overlay — their `blocks` / `relates_to`
// / `duplicates` links to other tickets *and other epics* draw exactly like a
// story's. This preview seeds those edges directly (the live view fetches them
// per-ticket from the hub) so the epic-relationship rendering is visible
// without a workspace that happens to have relation data.
#Preview("Epic relationships") {
    let now = Date.now
    let tickets: [Ticket] = [
        Ticket(id: "SCP-1", title: "Realtime sync epic", type: .epic, status: .in_progress,
               priority: .high, description: nil, parentId: nil, assignee: nil, labels: [],
               createdAt: now.addingTimeInterval(-9000), updatedAt: now),
        Ticket(id: "SCP-2", title: "WebSocket transport", type: .story, status: .done,
               priority: .high, description: nil, parentId: "SCP-1", assignee: nil, labels: [],
               createdAt: now.addingTimeInterval(-8000), updatedAt: now),
        Ticket(id: "SCP-3", title: "Reconnect with backoff", type: .story, status: .in_progress,
               priority: .medium, description: nil, parentId: "SCP-1", assignee: nil, labels: [],
               createdAt: now.addingTimeInterval(-7000), updatedAt: now),
        Ticket(id: "SCP-5", title: "Onboarding epic", type: .epic, status: .backlog,
               priority: .medium, description: nil, parentId: nil, assignee: nil, labels: [],
               createdAt: now.addingTimeInterval(-5000), updatedAt: now),
        Ticket(id: "SCP-6", title: "Pairing screen", type: .story, status: .in_review,
               priority: .medium, description: nil, parentId: "SCP-5", assignee: nil, labels: [],
               createdAt: now.addingTimeInterval(-4000), updatedAt: now),
    ]
    let layout = FlowGraphLayout.build(tickets: tickets, availableWidth: 760, collapsed: [])
    let relations: [RelationEdge] = [
        RelationEdge(from: "SCP-1", to: "SCP-5", type: .blocks),      // epic → epic
        RelationEdge(from: "SCP-5", to: "SCP-3", type: .relates_to),  // epic → another epic's ticket
        RelationEdge(from: "SCP-1", to: "SCP-6", type: .duplicates),  // epic → ticket
    ]
    ScrollView([.horizontal, .vertical]) {
        ZStack(alignment: .topLeading) {
            FlowGraphEdges(
                parentEdges: layout.parentEdges,
                relationEdges: relations,
                positions: layout.positions,
                clusterRects: layout.clusterRects,
                highlightedId: nil
            )
            .frame(width: layout.size.width, height: layout.size.height)

            ForEach(layout.nodes) { node in
                FlowGraphNodeView(
                    ticket: node.ticket,
                    childCount: node.childCount,
                    collapsed: false,
                    dimmed: false,
                    selected: false,
                    onTap: {},
                    onToggleCollapse: {}
                )
                .frame(width: FlowGraphLayout.nodeWidth, height: FlowGraphLayout.nodeHeight)
                .position(node.center)
            }
        }
        .frame(width: layout.size.width, height: layout.size.height)
        .padding(40)
    }
}
