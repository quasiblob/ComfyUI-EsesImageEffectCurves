// ==========================================================================
//  Eses Image Effect Curves
// ==========================================================================
//
// Description:
// The 'Eses Image Effect Curves' node provides a versatile, Photoshop-style curves
// adjustment tool directly within the ComfyUI interface. It allows for
// precise, interactive control over the tonal range of images and masks.
//
// Key Features:
//
// - Interactive Curve Editor:
//   - A fully interactive preview of the curve is displayed directly on the node.
//   - Features five editable points for detailed curve shaping.
//   - Supports moving all points, including endpoints, on both the X and Y axes
//     for advanced effects like level inversion and crushing blacks/whites.
//
// - Multi-Channel Adjustments:
//   - Apply curves to the combined RGB channels.
//   - Isolate adjustments to the individual Red, Green, or Blue channels.
//   - Apply a separate curve directly to an input mask.
//
// - State Serialization:
//   - All curve adjustments are saved with the workflow and restored on reload.
//   - The node's state persists even after refreshing the browser page.
//
// - Live Preview:
//   - The node displays a preview of the connected image with the curve
//     adjustment applied in real-time as you drag the points.
//
// - Quality of Life Features:
//   - Automatic resizing of the node to match the aspect ratio of the input image.
//   - "Reset Curve" button to revert the current channel's curve to linear.
//   - "Reset Node Size" button to re-trigger the auto-sizing.
//   - Visual "clamping" lines show when endpoints are moved from the edges,
//     providing clear feedback on the adjustment range.
//
// Version: 1.2.0 (Added Preset Saving)
//
// License: See LICENSE.txt
//
// ==========================================================================


import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";

// --- GLOBAL CONSTANTS ---
const HEADER_HEIGHT = 228;
const PADDING = 5;
const TOP_PADDING = 5;
const HISTOGRAM_AREA_HEIGHT = 30;
const AREA_SPACING = 8;


// --- PRESET HANDLING ---
let allPresets = null;
async function getPresets() {
    if (allPresets === null) {
        try {
            const response = await api.fetchApi("/eses_channel_curves/get_presets", { cache: "no-store" });
            allPresets = await response.json();
        } catch (e) {
            allPresets = {};
        }
    }
    return allPresets;
}

getPresets();



// --- NODE REGISTRATION ---
app.registerExtension({
    name: "Eses.EsesImageEffectCurves",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name === "EsesImageEffectCurves") {
            const presets = await getPresets();
            const presetNames = ["None", ...Object.keys(presets)];
            const presetInput = nodeData.input.required.preset;
            if (presetInput) {
                presetInput[0] = presetNames;
            }
        }
    },

    nodeCreated(node) {
        if (node.comfyClass === "EsesImageEffectCurves") {
            const originalConfigure = node.configure;
            const originalSerialize = node.serialize;

            node.size = [256, 420];
            node.imagePreview = null;
            node.originalImage = null;
            node.originalMask = null;
            node.isManuallyResized = false;
            node.lastKnownSrc = null;
            node.selectedPointIndex = -1;
            node.isDragging = false;
            node.histograms = {};

            const defaultCurve = () => [{ x: 0.0, y: 0.0, fixed: false }, { x: 1.0, y: 1.0, fixed: false }];
            node.allCurves = { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve(), luma: defaultCurve(), sat: defaultCurve(), mask: defaultCurve() };

            Object.assign(node, {
                getImageAndCurveArea: function () {
                    if (!this.size) return null;
                    const totalContentHeight = this.size[1] - HEADER_HEIGHT - PADDING * 2 - TOP_PADDING;
                    const mainAreaHeight = totalContentHeight - HISTOGRAM_AREA_HEIGHT - AREA_SPACING;
                    if (mainAreaHeight < 10) return null;
                    const area = { x: PADDING, y: HEADER_HEIGHT + TOP_PADDING, width: this.size[0] - PADDING * 2, height: mainAreaHeight };
                    return (area.width < 1 || area.height < 1) ? null : area;
                },

                getHistogramArea: function () {
                    const imageArea = this.getImageAndCurveArea();
                    if (!imageArea) return null;
                    return { x: PADDING, y: imageArea.y + imageArea.height + AREA_SPACING, width: this.size[0] - PADDING * 2, height: HISTOGRAM_AREA_HEIGHT };
                },

                updateHistogram: async function () {
                    const channelWidget = this.widgets.find(w => w.name === "channel");
                    let base_data_image = (this.activeChannel === 'mask') ? this.originalMask : this.originalImage;
                    if (!base_data_image) return;

                    const cacheKey = this.activeChannel;
                    const canvas = document.createElement('canvas');
                    canvas.width = base_data_image.naturalWidth;
                    canvas.height = base_data_image.naturalHeight;
                    canvas.getContext('2d').drawImage(base_data_image, 0, 0);
                    const base_data_b64 = canvas.toDataURL('image/png').split(',')[1];
                    try {
                        const result = await api.fetchApi("/eses_channel_curves/get_histogram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_data_b64, channel_mode: channelWidget.value }) }).then(r => r.json());
                        if (result.histogram) {
                            this.histograms[cacheKey] = result.histogram;
                            this.setDirtyCanvas(true, true);
                        }
                    } catch (err) { console.error("[EsesChannelCurves] Failed to fetch histogram:", err); }
                },

                updateHistogramFromPreview: async function () {
                    if (!this.imagePreview) return;
                    const channelWidget = this.widgets.find(w => w.name === "channel");
                    const base_data_image = this.imagePreview;
                    const canvas = document.createElement('canvas');
                    canvas.width = base_data_image.naturalWidth;
                    canvas.height = base_data_image.naturalHeight;
                    canvas.getContext('2d').drawImage(base_data_image, 0, 0);
                    const base_data_b64 = canvas.toDataURL('image/png').split(',')[1];
                    try {
                        const result = await api.fetchApi("/eses_channel_curves/get_histogram", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_data_b64, channel_mode: channelWidget.value }) }).then(r => r.json());
                        if (result.histogram) {
                            this.histograms[this.activeChannel] = result.histogram;
                            this.setDirtyCanvas(true, true);
                        }
                    } catch (err) { console.error("[EsesChannelCurves] Failed to fetch preview histogram:", err); }
                },

                sendCurveUpdateToPython: async function () {
                    const curvesWidget = this.widgets.find(w => w.name === "all_curves_json");
                    if (!curvesWidget) return;
                    let base_data_type, base_data_image;
                    if (this.activeChannel === 'mask') {
                        if (!this.originalMask) { this.imagePreview = null; this.setDirtyCanvas(true, true); return; }
                        base_data_type = 'mask';
                        base_data_image = this.originalMask;
                    } else {
                        if (!this.originalImage) { this.imagePreview = null; this.setDirtyCanvas(true, true); return; }
                        base_data_type = 'image';
                        base_data_image = this.originalImage;
                    }
                    const serializableCurves = {};
                    for (const key in this.allCurves) { serializableCurves[key] = this.allCurves[key].map(p => [p.x, p.y]); }
                    curvesWidget.value = JSON.stringify(serializableCurves);
                    const canvas = document.createElement('canvas');
                    canvas.width = base_data_image.naturalWidth;
                    canvas.height = base_data_image.naturalHeight;
                    canvas.getContext('2d').drawImage(base_data_image, 0, 0);
                    const base_data_b64 = canvas.toDataURL('image/png').split(',')[1];
                    try {
                        const result = await api.fetchApi("/eses_channel_curves/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_data_b64, all_curves_json: curvesWidget.value, base_data_type }) }).then(r => r.json());
                        if (result.adjusted_image_data) {
                            const img = new Image();
                            img.src = `data:image/png;base64,${result.adjusted_image_data}`;
                            img.onload = () => {
                                this.imagePreview = img;
                                this.updateHistogramFromPreview();
                                this.setDirtyCanvas(true, true);
                            };
                        }
                    } catch (err) {}
                },

                drawHistogram: function (ctx, area, data, step = 1) {
                    if (!data || data.length === 0) return;
                    step = Math.max(1, Math.floor(step));
                    const channelColors = { rgb: "rgba(204,204,204,0.7)", r: "rgba(255,100,100,0.7)", g: "rgba(100,255,100,0.7)", b: "rgba(100,100,255,0.7)", luma: "rgba(230,230,230,0.7)", sat: "rgba(255,165,0,0.7)", mask: "rgba(255,0,255,0.7)" };
                    ctx.fillStyle = channelColors[this.activeChannel] || "rgba(204,204,204,0.7)";
                    const baseBarWidth = area.width / 256;
                    for (let i = 0; i < 256; i += step) {
                        const chunk = data.slice(i, i + step);
                        if (chunk.length === 0) continue;
                        const maxVal = Math.max(...chunk);
                        const barHeight = maxVal * area.height;
                        const barWidth = baseBarWidth * chunk.length;
                        const x = area.x + i * baseBarWidth;
                        ctx.fillRect(x, area.y + area.height - barHeight, barWidth, barHeight);
                    }
                },

                onDrawForeground: function (ctx) {
                    if (this.flags?.collapsed) return;
                    const drawArea = this.getImageAndCurveArea();
                    const histogramArea = this.getHistogramArea();
                    if (!drawArea) return;

                    if (histogramArea) {
                        ctx.fillStyle = "#222";
                        ctx.fillRect(histogramArea.x, histogramArea.y, histogramArea.width, histogramArea.height);
                        const histogramData = this.histograms[this.activeChannel];
                        if (histogramData) {
                            this.drawHistogram(ctx, histogramArea, histogramData, 1);
                        }
                    }

                    if (this.imagePreview) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(drawArea.x, drawArea.y, drawArea.width, drawArea.height);
                        ctx.clip();
                        ctx.drawImage(this.imagePreview, drawArea.x, drawArea.y, drawArea.width, drawArea.height);
                        ctx.strokeStyle = "rgba(128,128,128,0.3)";
                        ctx.lineWidth = 1;
                        for (let i = 1; i < 4; i++) {
                            ctx.beginPath();
                            ctx.moveTo(drawArea.x + drawArea.width * i / 4, drawArea.y);
                            ctx.lineTo(drawArea.x + drawArea.width * i / 4, drawArea.y + drawArea.height);
                            ctx.stroke();
                            ctx.beginPath();
                            ctx.moveTo(drawArea.x, drawArea.y + drawArea.height * i / 4);
                            ctx.lineTo(drawArea.x + drawArea.width, drawArea.y + drawArea.height * i / 4);
                            ctx.stroke();
                        }
                        const channelColors = { rgb: "rgba(255,255,0,1)", r: "rgba(255,100,100,1)", g: "rgba(100,255,100,1)", b: "rgba(100,100,255,1)", luma: "rgba(230,230,230,1)", sat: "rgba(255,165,0,1)", mask: "rgba(255,0,255,1)" };
                        const pointColors = { rgb: "rgba(0,255,0,1)", r: "rgba(255,0,0,1)", g: "rgba(0,255,0,1)", b: "rgba(0,0,255,1)", luma: "rgba(230,230,230,1)", sat: "rgba(255,165,0,1)", mask: "rgba(255,0,255,1)" };
                        const activePoints = this.allCurves[this.activeChannel];
                        if (activePoints) {
                            const screenPoints = activePoints.map(p => ({ x: drawArea.x + p.x * drawArea.width, y: drawArea.y + (1.0 - p.y) * drawArea.height }));
                            ctx.strokeStyle = channelColors[this.activeChannel] || 'white';
                            ctx.lineWidth = 2;
                            ctx.beginPath();
                            ctx.moveTo(screenPoints[0].x, screenPoints[0].y);
                            for (let i = 0; i < screenPoints.length - 1; i++) {
                                const p0 = screenPoints[i === 0 ? 0 : i - 1], p1 = screenPoints[i], p2 = screenPoints[i + 1], p3 = screenPoints[i + 2 >= screenPoints.length ? screenPoints.length - 1 : i + 2];
                                for (let t_i = 1; t_i <= 20; t_i++) {
                                    let t = t_i / 20, t2 = t * t, t3 = t * t * t;
                                    let x = 0.5 * ((2 * p1.x) + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
                                    let y = 0.5 * ((2 * p1.y) + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
                                    ctx.lineTo(x, y);
                                }
                            }
                            ctx.stroke();
                            const baseColor = channelColors[this.activeChannel] || 'white';
                            const transparentColor = baseColor.replace(',1)', ',0.5)');
                            ctx.save();
                            ctx.strokeStyle = transparentColor;
                            const firstPointData = activePoints[0];
                            const firstPointScreen = screenPoints[0];
                            if (firstPointData.x > 0) {
                                ctx.beginPath();
                                ctx.moveTo(drawArea.x, firstPointScreen.y);
                                ctx.lineTo(firstPointScreen.x, firstPointScreen.y);
                                ctx.stroke();
                            }
                            const lastPointData = activePoints[activePoints.length - 1];
                            const lastPointScreen = screenPoints[screenPoints.length - 1];
                            if (lastPointData.x < 1.0) {
                                ctx.beginPath();
                                ctx.moveTo(lastPointScreen.x, lastPointScreen.y);
                                ctx.lineTo(drawArea.x + drawArea.width, lastPointScreen.y);
                                ctx.stroke();
                            }
                            ctx.restore();
                            for (let i = 0; i < screenPoints.length; i++) {
                                const p_scr = screenPoints[i];
                                ctx.beginPath(); ctx.arc(p_scr.x, p_scr.y, 6, 0, Math.PI * 2);
                                if (i === this.selectedPointIndex) {
                                    ctx.fillStyle = "rgba(255,165,0,1)";
                                } else {
                                    ctx.fillStyle = pointColors[this.activeChannel] || 'white';
                                }
                                ctx.strokeStyle = "rgba(255,255,255,1)";
                                ctx.lineWidth = 2;
                                ctx.fill();
                                ctx.stroke();
                            }
                        }
                        ctx.restore();
                    } else {
                        const drawArea = this.getImageAndCurveArea();
                        if (drawArea) {
                            ctx.save();
                            ctx.font = "14px Arial";
                            ctx.fillStyle = "#CCCCCC";
                            ctx.textAlign = "center";
                            ctx.textBaseline = "middle";
                            let placeholder = (this.activeChannel === 'mask') ? "Connect Mask and run workflow" : "Connect Image and run workflow";
                            ctx.fillText(placeholder, drawArea.x + drawArea.width / 2, drawArea.y + drawArea.height / 2);
                            ctx.restore();
                        }
                    }
                },

                onMouseDown: function (event) {
                    const drawArea = this.getImageAndCurveArea();

                    if (event.button !== 0 || !this.imagePreview || !drawArea) return false;

                    const localPos = app.canvas.convertEventToCanvasOffset(event);
                    const mouseX = localPos[0] - this.pos[0];
                    const mouseY = localPos[1] - this.pos[1];

                    if (mouseX < drawArea.x || mouseX > drawArea.x + drawArea.width || mouseY < drawArea.y || mouseY > drawArea.y + drawArea.height) return false;

                    const activePoints = this.allCurves[this.activeChannel];

                    for (let i = 0; i < activePoints.length; i++) {
                        const p = activePoints[i];
                        const pointScreenX = drawArea.x + p.x * drawArea.width;
                        const pointScreenY = drawArea.y + (1.0 - p.y) * drawArea.height;
                        const distance = Math.sqrt(Math.pow(mouseX - pointScreenX, 2) + Math.pow(mouseY - pointScreenY, 2));

                        if (distance < 15) {
                            if (event.shiftKey) {
                                if (i > 0 && i < activePoints.length - 1) {
                                    activePoints.splice(i, 1);
                                    this.sendCurveUpdateToPython();
                                }
                            } else {
                                this.selectedPointIndex = i;
                            }
                            this.setDirtyCanvas(true, true);
                            return true;
                        }
                    }

                    if (event.shiftKey) return false;

                    let newX = (mouseX - drawArea.x) / drawArea.width;
                    let newY = 1.0 - ((mouseY - drawArea.y) / drawArea.height);

                    newX = Math.max(0.0, Math.min(1.0, newX));
                    newY = Math.max(0.0, Math.min(1.0, newY));

                    const newPoint = { x: newX, y: newY, fixed: false };
                    const insertIndex = activePoints.findIndex(p => p.x > newX);

                    activePoints.splice(insertIndex === -1 ? activePoints.length : insertIndex, 0, newPoint);
                    this.selectedPointIndex = insertIndex === -1 ? activePoints.length - 1 : insertIndex;
                    this.isDragging = true;
                    this.setDirtyCanvas(true, true);

                    return true;
                },

                onMouseMove: function (event) {
                    if (event.buttons !== 1) {

                        if (this.isDragging || this.selectedPointIndex !== -1) {
                            this.isDragging = false;
                            this.selectedPointIndex = -1;
                            this.setDirtyCanvas(true, true);
                        }
                        return;
                    }

                    if (this.selectedPointIndex === -1) return;

                    this.isDragging = true;
                    const drawArea = this.getImageAndCurveArea();

                    if (!drawArea) return;

                    const localPos = app.canvas.convertEventToCanvasOffset(event);
                    const mouseX = localPos[0] - this.pos[0],
                        mouseY = localPos[1] - this.pos[1];

                    const activePoints = this.allCurves[this.activeChannel];
                    const point = activePoints[this.selectedPointIndex];

                    let newY = 1.0 - ((mouseY - drawArea.y) / drawArea.height);
                    point.y = Math.max(0, Math.min(1, newY));

                    let newX = (mouseX - drawArea.x) / drawArea.width;

                    const minX = (this.selectedPointIndex > 0) ? activePoints[this.selectedPointIndex - 1].x + 0.001 : 0;
                    const maxX = (this.selectedPointIndex < activePoints.length - 1) ? activePoints[this.selectedPointIndex + 1].x - 0.001 : 1;
                    point.x = Math.max(minX, Math.min(maxX, newX));

                    this.setDirtyCanvas(true, true);
                    clearTimeout(this.updateTimeout);
                    this.updateTimeout = setTimeout(() => this.sendCurveUpdateToPython(), 50);
                },

                onMouseUp: function (event) {
                    if (this.isDragging) {
                        this.isDragging = false;
                        if (this.selectedPointIndex !== -1) {
                            this.sendCurveUpdateToPython();
                        }
                    }
                },

            });


            node.onResize = function () {
                this.isManuallyResized = true;
            };

            function setupCustomWidgets() {
                const copySettingsButton = node.widgets.find(w => w.name === "Copy Settings");
                if (copySettingsButton) {
                    node.widgets.splice(node.widgets.indexOf(copySettingsButton), 1);
                }

                if (!node.widgets.find(w => w.name === "Preset Name")) {
                    const presetNameWidget = node.addWidget("string", "Preset Name", "", {});
                    node.addWidget("button", "Save Preset", null, async () => {
                        const name = presetNameWidget.value;
                        if (!name || !name.trim()) {
                            alert("Please enter a preset name.");
                            return;
                        }

                        try {
                            const resp = await api.fetchApi("/eses_channel_curves/save_preset", {
                                method: "POST",
                                headers: { "Content-Type": "application/json" },
                                body: JSON.stringify({
                                    preset_name: name,
                                    preset_data: node.allCurves,
                                }),
                            });
                            const res = await resp.json();

                            if (res.success) {
                                alert(`Preset '${name}' saved successfully!`);
                                allPresets = res.presets;
                                const presetWidget = node.widgets.find(w => w.name === "preset");
                                if(presetWidget) {
                                    presetWidget.options.values = ["None", ...Object.keys(allPresets)];
                                    presetWidget.value = name;
                                }
                                presetNameWidget.value = "";
                            } else {
                                alert(`Error saving preset: ${res.message}`);
                            }
                        } catch (e) {
                            console.error("[EsesChannelCurves] Error saving preset:", e);
                            alert(`An error occurred: ${e}`);
                        }
                    });
                }


                const presetWidget = node.widgets.find(w => w.name === "preset");

                if (presetWidget) {
                    presetWidget.callback = async (value) => {
                        if (value === "None")
                            return;

                        const presets = await getPresets();
                        const selectedPreset = presets[value];

                        if (selectedPreset) {
                            node.allCurves = JSON.parse(JSON.stringify(selectedPreset));
                            const allChannels = ["rgb", "r", "g", "b", "luma", "sat", "mask"];

                            for (const ch of allChannels) {
                                if (!node.allCurves[ch]) {
                                    node.allCurves[ch] = defaultCurve();
                                }
                            }
                            node.sendCurveUpdateToPython();
                            node.setDirtyCanvas(true, true);
                        }
                    };
                }

                const oldResetBtn = node.widgets.find(w => w.name === "Reset All Curves");

                if (oldResetBtn)
                    node.widgets.splice(node.widgets.indexOf(oldResetBtn), 1);

                const oldSizeResetBtn = node.widgets.find(w => w.name === "Reset Node Size");

                if (oldSizeResetBtn)
                    node.widgets.splice(node.widgets.indexOf(oldSizeResetBtn), 1);

                const curvesWidget = node.widgets.find(w => w.name === "all_curves_json");
                const channelWidget = node.widgets.find(w => w.name === "channel");

                if (!curvesWidget || !channelWidget) return;

                curvesWidget.type = "hidden";
                const channelMap = { "RGB": "rgb", "Red": "r", "Green": "g", "Blue": "b", "Luminosity": "luma", "Saturation": "sat", "Mask": "mask" };
                node.activeChannel = channelMap[channelWidget.value] || "rgb";

                const getResetButtonName = (isConfirm = false, channelValue) => {
                    const name = channelValue || channelWidget.value;

                    if (node.activeChannel === 'rgb')
                        return isConfirm ? "CONFIRM RESET ALL" : "Reset All Curves";

                    return isConfirm ? `CONFIRM RESET ${name}` : `Reset ${name} Curve`;
                };

                node.addWidget("button", "Reset Node Size", null, () => {
                    node.isManuallyResized = false;
                    const sizingObj = node.originalImage || node.originalMask;

                    if (sizingObj) {
                        const aspectRatio = sizingObj.naturalWidth / sizingObj.naturalHeight;
                        const baseWidth = 256;
                        node.size[0] = baseWidth;
                        const drawAreaHeight = (baseWidth - (PADDING * 2)) / (aspectRatio || 1);
                        node.size[1] = drawAreaHeight + HEADER_HEIGHT + TOP_PADDING + PADDING + HISTOGRAM_AREA_HEIGHT + AREA_SPACING;
                        node.setDirtyCanvas(true, true);
                    }
                });

                let resetButton = node.widgets.find(w => w.name === "Reset All Curves");

                if (!resetButton) {
                    resetButton = node.addWidget("button", getResetButtonName(false, channelWidget.value), null, () => {});
                }

                resetButton.callback = () => {

                    if (node.resetButtonState === 'armed') {
                        clearTimeout(node.resetTimeout);

                        if (node.activeChannel === 'rgb') {
                            node.allCurves = { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve(), luma: defaultCurve(), sat: defaultCurve(), mask: defaultCurve() };
                        }

                        else {
                            node.allCurves[node.activeChannel] = defaultCurve();
                        }

                        node.sendCurveUpdateToPython();
                        resetButton.name = getResetButtonName(false, channelWidget.value);
                        node.resetButtonState = 'idle';
                    }
                    else {
                        node.resetButtonState = 'armed';
                        resetButton.name = getResetButtonName(true, channelWidget.value);

                        node.resetTimeout = setTimeout(() => {
                            resetButton.name = getResetButtonName(false, channelWidget.value);
                            node.resetButtonState = 'idle';
                            app.graph.setDirtyCanvas(true);
                        }, 3000);
                    }
                    app.graph.setDirtyCanvas(true);
                };

                channelWidget.callback = (value) => {
                    node.activeChannel = channelMap[value] || "rgb";
                    resetButton.name = getResetButtonName(false, value);
                    node.updateHistogram();
                    node.sendCurveUpdateToPython();
                };
            }

            node.configure = function (data) {
                originalConfigure.apply(this, arguments);
                setupCustomWidgets();

                if (data.isManuallyResized)
                    this.isManuallyResized = data.isManuallyResized;

                if (data.custom_all_curves) {
                    Object.assign(this.allCurves, data.custom_all_curves);
                    const curvesWidget = this.widgets.find(w => w.name === "all_curves_json");

                    if (curvesWidget) {
                        const serializableCurves = {};

                        for (const key in this.allCurves) {
                            serializableCurves[key] = this.allCurves[key].map(p => [p.x, p.y]);
                        }
                        curvesWidget.value = JSON.stringify(serializableCurves);
                    }
                }
            };

            node.serialize = function () {
                const data = originalSerialize.call(this);
                data.custom_all_curves = node.allCurves;
                data.isManuallyResized = node.isManuallyResized;
                return data;
            };

            setupCustomWidgets();
        }
    },
});

// Event listeners --------
api.addEventListener("eses.channel_curves_preview", ({ detail }) => {
    const node = app.graph.getNodeById(detail.node_id);
    if (node) {
        const onAssetLoad = async () => {

            if (!node.isManuallyResized) {
                const sizingObj = node.originalImage || node.originalMask;

                if (sizingObj) {
                    const aspectRatio = sizingObj.naturalWidth / sizingObj.naturalHeight;
                    const baseWidth = 256;
                    node.size[0] = baseWidth;
                    const drawAreaHeight = (baseWidth - (PADDING * 2)) / (aspectRatio || 1);
                    node.size[1] = drawAreaHeight + HEADER_HEIGHT + TOP_PADDING + PADDING + HISTOGRAM_AREA_HEIGHT + AREA_SPACING;
                    node.isManuallyResized = true;
                }
            }
            await node.updateHistogram();
            await node.sendCurveUpdateToPython();
        };

        let assetsToLoad = 0;

        if (detail.image_data) assetsToLoad++;
        if (detail.mask_data) assetsToLoad++;

        if (assetsToLoad === 0) {
            onAssetLoad();
            return;
        }

        let loadedCount = 0;
        const assetLoadedCallback = async () => {
            if (++loadedCount === assetsToLoad) await onAssetLoad();
        };

        if (detail.image_data) {
            const img = new Image();
            img.src = "data:image/png;base64," + detail.image_data;
            img.onload = assetLoadedCallback;
            node.originalImage = img;
        }
        else {
            node.originalImage = null;
        }

        if (detail.mask_data) {
            const mask = new Image();
            mask.src = "data:image/png;base64," + detail.mask_data;
            mask.onload = assetLoadedCallback;
            node.originalMask = mask;
        }
        else {
            node.originalMask = null;
        }
    }
});