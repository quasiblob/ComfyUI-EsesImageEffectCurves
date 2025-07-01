import { app } from "/scripts/app.js";
import { api } from "/scripts/api.js";


// --- GLOBAL CONSTANTS ---

const HEADER_HEIGHT = 202;
const PADDING = 5;
const TOP_PADDING = 5;



// --- PRESET HANDLING START ---

// Global cache for presets to avoid 
// fetching them for every single node
let allPresets = null;
async function getPresets() {
    if (allPresets === null) {
        try {
            const response = await api.fetchApi("/eses_channel_curves/get_presets", { cache: "no-store" });
            allPresets = await response.json();
            console.log("[EsesChannelCurves] Presets loaded:", allPresets);
        } catch (e) {
            console.error("[EsesChannelCurves] Failed to load presets:", e);
            allPresets = {}; // Set to empty object on failure
        }
    }
    return allPresets;
}

// Fetch presets on script load
getPresets();

// --- PRESET HANDLING END ---



// Node related ------------

app.registerExtension({
    name: "Eses.EsesImageEffectCurves",

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // --- PRESET HANDLING START ---

        // Runs once when the node definition is being registered.
        // Dynamically add the preset names to the combo box definition.
        if (nodeData.name === "EsesImageEffectCurves") {
            const presets = await getPresets();
            const presetNames = ["None", ...Object.keys(presets)];
            
            // Find the 'preset' input in the 
            // node's definition and update its options
            const presetInput = nodeData.input.required.preset;
            if(presetInput) {
                presetInput[0] = presetNames;
            }
        }

        // --- PRESET HANDLING END ---
    },


    nodeCreated(node) {
        
        if (node.comfyClass === "EsesImageEffectCurves") {
            
            const originalConfigure = node.configure;
            const originalSerialize = node.serialize;

            node.size = [256, 350];
            node.imagePreview = null;
            node.originalImage = null;
            node.originalMask = null;
            node.isManuallyResized = false;
            node.lastKnownSrc = null;
            node.selectedPointIndex = -1;
            node.isDragging = false;

            const defaultCurve = () => [{ x: 0.0, y: 0.0, fixed: false }, { x: 1.0, y: 1.0, fixed: false }];
            node.allCurves = { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve(), luma: defaultCurve(), sat: defaultCurve(), mask: defaultCurve() }; // Add sat

            node.onResize = function() {
                this.isManuallyResized = true;
            };

            function setupCustomWidgets() {
                
                const oldCopyBtn = node.widgets.find(w => w.name === "Copy Settings");
                if (oldCopyBtn) {
                    node.widgets.splice(node.widgets.indexOf(oldCopyBtn), 1);
                }

                
                // --- PRESET HANDLING START ---
                
                // Add button to copy settings
                node.addWidget("button", "Copy Settings", null, () => {
                    const settingsString = JSON.stringify(node.allCurves, null, 2);
                    
                    navigator.clipboard.writeText(settingsString).then(() => {
                        alert("Curve settings copied to clipboard!");
                    }, (err) => {
                        console.error('Could not copy text: ', err);
                        prompt("Copy this to your presets.json file:", settingsString);
                    });
                });


                // Setup callback for the preset dropdown
                const presetWidget = node.widgets.find(w => w.name === "preset");

                if (presetWidget) {
                    presetWidget.callback = async (value) => {
                        if (value === "None") return;
                        
                        const presets = await getPresets();
                        const selectedPreset = presets[value];
                        
                        if (selectedPreset) {
                            // Deep copy to avoid modifying the cached preset
                            node.allCurves = JSON.parse(JSON.stringify(selectedPreset));

                            // Ensure all channels exist, even if not in preset
                            const allChannels = ["rgb", "r", "g", "b", "luma", "sat", "mask"];
                            for(const ch of allChannels) {
                                if(!node.allCurves[ch]) {
                                    node.allCurves[ch] = defaultCurve();
                                }
                            }

                            node.sendCurveUpdateToPython();
                            node.setDirtyCanvas(true, true);
                        }
                    };
                }
                
                // --- PRESET HANDLING END ---


                const oldResetBtn = node.widgets.find(w => w.name === "Reset All Curves");
                
                if (oldResetBtn) node.widgets.splice(node.widgets.indexOf(oldResetBtn), 1);
                
                const oldSizeResetBtn = node.widgets.find(w => w.name === "Reset Node Size");
                
                if (oldSizeResetBtn) node.widgets.splice(node.widgets.indexOf(oldSizeResetBtn), 1);
                
                const curvesWidget = node.widgets.find(w => w.name === "all_curves_json");
                const channelWidget = node.widgets.find(w => w.name === "channel");

                if (!curvesWidget || !channelWidget) { return; }

                curvesWidget.type = "hidden";
                
                const channelMap = { "RGB": "rgb", "Red": "r", "Green": "g", "Blue": "b", "Luminosity": "luma", "Saturation": "sat", "Mask": "mask" };

                node.activeChannel = channelMap[channelWidget.value] || "rgb";
                
                const getResetButtonName = (isConfirm = false, channelValue) => {
                    const name = channelValue || channelWidget.value;
                    
                    if (node.activeChannel === 'rgb') return isConfirm ? "CONFIRM RESET ALL" : "Reset All Curves";
                    
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
                        node.size[1] = drawAreaHeight + HEADER_HEIGHT + TOP_PADDING + PADDING;
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

                        // Resets ALL keys, including luma and sat.
                        if (node.activeChannel === 'rgb') node.allCurves = { rgb: defaultCurve(), r: defaultCurve(), g: defaultCurve(), b: defaultCurve(), luma: defaultCurve(), sat: defaultCurve(), mask: defaultCurve() };
                        else node.allCurves[node.activeChannel] = defaultCurve();

                        node.setDirtyCanvas(true, true);
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
                    node.sendCurveUpdateToPython();
                    app.graph.setDirtyCanvas(true);
                };

                node.setDirtyCanvas(true, true);
            }

            node.configure = function(data) {
                originalConfigure.apply(this, arguments);
                setupCustomWidgets();
                
                if (data.isManuallyResized) {
                    this.isManuallyResized = data.isManuallyResized;
                }

                if (data.custom_all_curves) {
                    // This line is the problem
                    // this.allCurves = data.custom_all_curves;
                    
                    // Merge loaded curves into the 
                    // existing object to ensure all keys exist
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

            node.serialize = function() {
                const data = originalSerialize.call(this);
                data.custom_all_curves = node.allCurves;
                data.isManuallyResized = node.isManuallyResized; 
                
                return data;
            };
            
            // Call the setup function immediately for new nodes.
            setupCustomWidgets();
            
            // Remove this !
            //setupCustomWidgets();

            Object.assign(node, {
                
                getDrawArea: function() {
                    if (!this.size) return null;
                    const area = { 
                        x: PADDING, 
                        y: HEADER_HEIGHT + TOP_PADDING,
                        width: this.size[0] - PADDING * 2, 
                        height: this.size[1] - (HEADER_HEIGHT + TOP_PADDING) - PADDING
                    };
                    return (area.width < 1 || area.height < 1) ? null : area;
                },

                sendCurveUpdateToPython: async function() {
                    const curvesWidget = this.widgets.find(w => w.name === "all_curves_json");
                    
                    if (!curvesWidget) return;
                    
                    let base_data_type, base_data_image;
                    
                    if (this.activeChannel === 'mask') { if (!this.originalMask) { this.imagePreview = null; this.setDirtyCanvas(true,true); return; } base_data_type = 'mask'; base_data_image = this.originalMask; }
                    else { if (!this.originalImage) { this.imagePreview = null; this.setDirtyCanvas(true,true); return; } base_data_type = 'image'; base_data_image = this.originalImage; }
                    
                    const serializableCurves = {};
                    
                    for (const key in this.allCurves) { serializableCurves[key] = this.allCurves[key].map(p => [p.x, p.y]); }
                                        
                    curvesWidget.value = JSON.stringify(serializableCurves);
                    this.setDirtyCanvas(true, true); 
                    const canvas = document.createElement('canvas'); canvas.width = base_data_image.naturalWidth; canvas.height = base_data_image.naturalHeight; canvas.getContext('2d').drawImage(base_data_image, 0, 0);
                    const base_data_b64 = canvas.toDataURL('image/png').split(',')[1];
                    
                    try {
                        const result = await api.fetchApi("/eses_channel_curves/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ base_data_b64, all_curves_json: curvesWidget.value, base_data_type }) }).then(r => r.json());
                        if (result.error) { console.error("API Error:", result.error); return; }
                        const img = new Image(); img.src = `data:image/png;base64,${result.adjusted_image_data}`;
                        img.onload = () => { this.imagePreview = img; this.setDirtyCanvas(true, true); };
                    } 
                    catch (err) {}
                },

                onDrawForeground: function(ctx) {
                    
                    // check if the node is collapsed
                    if (this.flags && this.flags.collapsed) {
                        return;
                    }

                    const drawArea = this.getDrawArea();
                    
                    if (!drawArea || drawArea.height < 1) return;
                    
                    if (this.imagePreview) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.rect(drawArea.x, drawArea.y, drawArea.width, drawArea.height);
                        ctx.clip();
                        ctx.drawImage(this.imagePreview, drawArea.x, drawArea.y, drawArea.width, drawArea.height);
                        ctx.strokeStyle = "rgba(128,128,128,0.3)";
                        ctx.lineWidth = 1;
                        
                        for (let i = 1; i < 4; i++) {
                            ctx.beginPath(); ctx.moveTo(drawArea.x + drawArea.width * i / 4, drawArea.y); ctx.lineTo(drawArea.x + drawArea.width * i / 4, drawArea.y + drawArea.height); ctx.stroke();
                            ctx.beginPath(); ctx.moveTo(drawArea.x, drawArea.y + drawArea.height * i / 4); ctx.lineTo(drawArea.x + drawArea.width, drawArea.y + drawArea.height * i / 4); ctx.stroke();
                        }
                        
                        const channelColors = { rgb: "rgba(255,255,0,1)", r: "rgba(255,100,100,1)", g: "rgba(100,255,100,1)", b: "rgba(100,100,255,1)", 
                                                luma: "rgba(230,230,230,1)", sat: "rgba(255,165,0,1)",mask: "rgba(255,0,255,1)" };
                        
                        const pointColors = { rgb: "rgba(0,255,0,1)", r: "rgba(255,0,0,1)", g: "rgba(0,255,0,1)", b: "rgba(0,0,255,1)", 
                                                luma: "rgba(230,230,230,1)", sat: "rgba(255,165,0,1)", mask: "rgba(255,0,255,1)" };
                        
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
                                
                                if (i === this.selectedPointIndex) ctx.fillStyle = "rgba(255,165,0,1)";
                                else ctx.fillStyle = pointColors[this.activeChannel] || 'white';
                                
                                ctx.strokeStyle = "rgba(255,255,255,1)"; ctx.lineWidth = 2;
                                ctx.fill(); ctx.stroke();
                            }
                        }
                        ctx.restore();
                    } 
                    else {
                        const drawArea = this.getDrawArea();
                        
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

                onMouseDown: function(event) {
                    const drawArea = this.getDrawArea();
                    if (event.button !== 0 || !this.imagePreview || !drawArea) {
                        return false;
                    }

                    const localPos = app.canvas.convertEventToCanvasOffset(event);
                    const mouseX = localPos[0] - this.pos[0];
                    const mouseY = localPos[1] - this.pos[1];

                    if (mouseX < drawArea.x || mouseX > drawArea.x + drawArea.width || mouseY < drawArea.y || mouseY > drawArea.y + drawArea.height) {
                        return false;
                    }

                    const activePoints = this.allCurves[this.activeChannel];
                    
                    // Check for a click on an existing point
                    for (let i = 0; i < activePoints.length; i++) {
                        const p = activePoints[i];
                        const pointScreenX = drawArea.x + p.x * drawArea.width;
                        const pointScreenY = drawArea.y + (1.0 - p.y) * drawArea.height;
                        const distance = Math.sqrt(Math.pow(mouseX - pointScreenX, 2) + Math.pow(mouseY - pointScreenY, 2));

                        if (distance < 15) {
                            if (event.shiftKey) { // Handle deletion
                                if (i > 0 && i < activePoints.length - 1) {
                                    activePoints.splice(i, 1);
                                    this.setDirtyCanvas(true, true);
                                    this.sendCurveUpdateToPython();
                                }
                                return true;
                            } 
                            else { 
                                // On mousedown, just select the 
                                // point. DO NOT start dragging yet.
                                this.selectedPointIndex = i;
                                
                                // Redraw to show selection
                                this.setDirtyCanvas(true, true); 
                                return true;
                            }
                        }
                    }

                    // No point was clicked. 
                    // Add a new point.
                    if(event.shiftKey) return false;
                    
                    let newX = (mouseX - drawArea.x) / drawArea.width;
                    let newY = 1.0 - ((mouseY - drawArea.y) / drawArea.height);
                    newX = Math.max(0.0, Math.min(1.0, newX));
                    newY = Math.max(0.0, Math.min(1.0, newY));

                    const newPoint = { x: newX, y: newY, fixed: false };
                    const insertIndex = activePoints.findIndex(p => p.x > newX);
                    
                    activePoints.splice(insertIndex === -1 ? activePoints.length : insertIndex, 0, newPoint);

                    // Select the new point and 
                    // immediately start dragging it.
                    this.selectedPointIndex = insertIndex === -1 ? activePoints.length -1 : insertIndex;
                    this.isDragging = true;
                    this.setDirtyCanvas(true, true);
                    
                    return true;
                },

                onMouseMove: function(event) {

                    // First, check the actual state of the mouse buttons from the event.
                    // The `buttons` property is a bitmask; '1' means the left button is down.
                    // If the left button is NOT pressed, we should absolutely not be dragging.
                    // This acts as a failsafe to reset the state if onMouseUp was missed.
                    if (event.buttons !== 1) {
                        if (this.isDragging || this.selectedPointIndex !== -1) {
                            this.isDragging = false;
                            this.selectedPointIndex = -1;
                            this.setDirtyCanvas(true, true);
                        }
                        return;
                    }

                    // If a point is selected and the 
                    // mouse button is down, start the drag.
                    if (this.selectedPointIndex !== -1 && !this.isDragging) {
                        this.isDragging = true;
                    }

                    // If we are not in a dragging 
                    // state, do nothing.
                    if (!this.isDragging) {
                        return;
                    }

                    const drawArea = this.getDrawArea();
                    if (!drawArea) return;
                    
                    const localPos = app.canvas.convertEventToCanvasOffset(event);
                    const mouseX = localPos[0] - this.pos[0], mouseY = localPos[1] - this.pos[1];
                    
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
                    this.updateTimeout = setTimeout(() => this.sendCurveUpdateToPython(), 100);
                },
                
                
                onMouseUp: function(event) {
                    if (this.selectedPointIndex !== -1) {
                        
                        // If we were dragging, send a final update.
                        if (this.isDragging) {
                            this.sendCurveUpdateToPython();
                        }
                        
                        // Reset all states.
                        this.isDragging = false;
                        this.selectedPointIndex = -1;
                        this.setDirtyCanvas(true, true);
                        return true;
                    }
                    return false;
                }

            });

        }
    },
});



// Event listeners --------

api.addEventListener("eses.channel_curves_preview", ({ detail }) => {
    const node = app.graph.getNodeById(detail.node_id);
    
    if (node) {
        const newSrc = detail.image_data || detail.mask_data; 
        
        if (newSrc && node.lastKnownSrc !== newSrc.slice(0, 40)) { 
            node.isManuallyResized = false; 
            node.lastKnownSrc = newSrc.slice(0, 40); 
        }

        let loadedCount = 0; const totalToLoad = (detail.image_data ? 1 : 0) + (detail.mask_data ? 1 : 0);
        
        const onAssetLoad = () => {
            loadedCount++;
            
            if (loadedCount === totalToLoad) {
                
                if (!node.isManuallyResized) {
                    const sizingObj = node.originalImage || node.originalMask;
                    
                    if (sizingObj) {
                        const aspectRatio = sizingObj.naturalWidth / sizingObj.naturalHeight;
                        const baseWidth = 256;
                        node.size[0] = baseWidth;
                        const drawAreaHeight = (baseWidth - (PADDING * 2)) / (aspectRatio || 1);
                        node.size[1] = drawAreaHeight + HEADER_HEIGHT + TOP_PADDING + PADDING;
                        node.isManuallyResized = true;
                    }
                }
                node.sendCurveUpdateToPython();
                app.graph.setDirtyCanvas(true, true);
            }
        };
        
        node.originalImage = null; if (detail.image_data) { const img = new Image(); img.src = "data:image/png;base64," + detail.image_data; img.onload = onAssetLoad; node.originalImage = img; }
        node.originalMask = null; if (detail.mask_data) { const mask = new Image(); mask.src = "data:image/png;base64," + detail.mask_data; mask.onload = onAssetLoad; node.originalMask = mask; }
        
        if (totalToLoad === 0 && loadedCount === 0) { onAssetLoad(); }
    }
});