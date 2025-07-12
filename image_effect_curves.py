# ==========================================================================
# Eses Image Effect Curves
# ==========================================================================
#
# Description:
# The 'Eses Image Effect Curves' node provides a versatile, Photoshop-style curves
# adjustment tool directly within the ComfyUI interface. It allows for
# precise, interactive control over the tonal range of images and masks.
#
# Key Features:
#
# - Interactive Curve Editor:
#   - A fully interactive preview of the curve is displayed directly on the node.
#   - Features five editable points for detailed curve shaping.
#   - Supports moving all points, including endpoints, on both the X and Y axes
#     for advanced effects like level inversion and crushing blacks/whites.
#
# - Multi-Channel Adjustments:
#   - Apply curves to the combined RGB channels.
#   - Isolate adjustments to the individual Red, Green, or Blue channels.
#   - Apply a separate curve directly to an input mask.
#
# - State Serialization:
#   - All curve adjustments are saved with the workflow and restored on reload.
#   - The node's state persists even after refreshing the browser page.
#
# - Live Preview:
#   - The node displays a preview of the connected image with the curve
#     adjustment applied in real-time as you drag the points.
#
# - Quality of Life Features:
#   - Automatic resizing of the node to match the aspect ratio of the input image.
#   - "Reset Curve" button to revert the current channel's curve to linear.
#   - "Reset Node Size" button to re-trigger the auto-sizing.
#   - Visual "clamping" lines show when endpoints are moved from the edges,
#     providing clear feedback on the adjustment range.
#
# Version: 1.2.0 (Added Preset Saving)
#
# License: See LICENSE.txt
#
# ==========================================================================

import torch
import numpy as np
from PIL import Image, ImageOps
from server import PromptServer # type: ignore
from io import BytesIO
import base64
import json
import os
import re
from aiohttp import web


# +++ Preset Handling Start +++

PRESETS_DIR = os.path.join(os.path.dirname(__file__), "presets")

# Ensure presets directory exists
if not os.path.exists(PRESETS_DIR):
    os.makedirs(PRESETS_DIR)


def load_presets():
    """
    Loads presets from individual .json files in the presets directory.
    The filename (without .json) is used as the preset name.
    """
    presets = {}
    if not os.path.isdir(PRESETS_DIR):
        return presets

    for filename in os.listdir(PRESETS_DIR):
        if filename.endswith(".json"):
            preset_name = os.path.splitext(filename)[0]
            file_path = os.path.join(PRESETS_DIR, filename)
            try:
                with open(file_path, "r") as f:
                    presets[preset_name] = json.load(f)
            except Exception as e:
                print(f"[EsesChannelCurves] Error loading preset file {filename}: {e}")
    return presets

# +++ Preset Handling End +++



class EsesImageEffectCurves:

    # Node Setup ------------

    # DEFAULT_LINEAR_CURVE = [ [0.0, 0.0], [0.25, 0.25], [0.5, 0.5], [0.75, 0.75], [1.0, 1.0] ]
    DEFAULT_LINEAR_CURVE = [ [0.0, 0.0], [1.0, 1.0] ]

    DEFAULT_ALL_CURVES = {
        "rgb": DEFAULT_LINEAR_CURVE, "r": DEFAULT_LINEAR_CURVE,
        "g": DEFAULT_LINEAR_CURVE, "b": DEFAULT_LINEAR_CURVE,
        "luma": DEFAULT_LINEAR_CURVE,
        "sat": DEFAULT_LINEAR_CURVE,
        "mask": DEFAULT_LINEAR_CURVE
    }
    DEFAULT_ALL_CURVES_JSON = json.dumps(DEFAULT_ALL_CURVES)

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("NaN")


    @classmethod
    def INPUT_TYPES(cls):

        # +++ Load presets for the dropdown +++
        preset_names = ["None"] + sorted(list(load_presets().keys())) # Added sorted() for consistency
        return {
            "required": {
                "preset": (preset_names, ),
                "channel": (["RGB", "Red", "Green", "Blue", "Luminosity", "Saturation", "Mask"],),
                "all_curves_json": ("STRING", {"default": cls.DEFAULT_ALL_CURVES_JSON, "multiline": True}),
            },
            "optional": {
                "image": ("IMAGE",),
                "mask": ("MASK",),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO", "unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "MASK", "IMAGE", "MASK")
    RETURN_NAMES = ("adjusted_image", "adjusted_mask", "image", "mask")
    FUNCTION = "execute"
    CATEGORY = "Eses Nodes/Image Adjustments"


    # Helpers ---------

    @staticmethod
    def _apply_curve(pil_img, curve_points):
        try:
            if len(curve_points) < 2: return pil_img

            if isinstance(curve_points[0], dict):
                 curve_points = [[p['x'], p['y']] for p in curve_points]

            curve_points.sort(key=lambda p: p[0])
            lookup_table = [0] * 256

            if len(curve_points) == 2:
                p1, p2 = curve_points[0], curve_points[1]
                x_range = (p2[0] - p1[0]) if p2[0] != p1[0] else 1
                y_range = p2[1] - p1[1]

                for i in range(256):
                    input_val = i / 255.0
                    if input_val < p1[0]:
                        output_val = p1[1]
                    elif input_val > p2[0]:
                        output_val = p2[1]
                    else:
                        t = (input_val - p1[0]) / x_range
                        output_val = p1[1] + t * y_range

                    lookup_table[i] = int(np.clip(output_val * 255, 0, 255))
            else:
                for i in range(256):
                    input_val, output_val, found = i / 255.0, 0.0, False

                    for j in range(len(curve_points) - 1):
                        p1, p2 = curve_points[j], curve_points[j+1]

                        if input_val >= p1[0] and input_val <= p2[0]:

                            p0 = curve_points[max(0, j - 1)]
                            p3 = curve_points[min(len(curve_points) - 1, j + 2)]

                            t = (input_val - p1[0]) / (p2[0] - p1[0]) if p2[0] != p1[0] else 0
                            t2, t3 = t*t, t*t*t
                            output_val = 0.5 * ((2*p1[1]) + (-p0[1]+p2[1])*t + (2*p0[1]-5*p1[1]+4*p2[1]-p3[1])*t2 + (-p0[1]+3*p1[1]-3*p2[1]+p3[1])*t3)
                            found = True; break

                    if not found: output_val = curve_points[0][1] if input_val <= curve_points[0][0] else curve_points[-1][1]

                    lookup_table[i] = int(np.clip(output_val * 255, 0, 255))

            if pil_img.mode == 'RGB': lookup_table *= 3

            return pil_img.point(lookup_table)

        except Exception as e: print(f"Error applying curve: {e}"); return pil_img


    @classmethod
    def process_image(cls, pil_image, curves_dict):
        hsv_img = pil_image.convert('HSV')
        h_chan, s_chan, v_chan = hsv_img.split()

        v_chan_adj = cls._apply_curve(v_chan, curves_dict["luma"])
        s_chan_adj = cls._apply_curve(s_chan, curves_dict["sat"])

        luma_adjusted_hsv = Image.merge("HSV", (h_chan, s_chan_adj, v_chan_adj))
        luma_adjusted_rgb = luma_adjusted_hsv.convert('RGB')

        r_chan, g_chan, b_chan = luma_adjusted_rgb.split()
        r_adj = cls._apply_curve(r_chan, curves_dict["r"])
        g_adj = cls._apply_curve(g_chan, curves_dict["g"])
        b_adj = cls._apply_curve(b_chan, curves_dict["b"])

        merged_channels_img = Image.merge("RGB", (r_adj, g_adj, b_adj))

        return cls._apply_curve(merged_channels_img, curves_dict["rgb"])


    def execute(self, channel, all_curves_json, preset, image=None, mask=None, prompt=None, extra_pnginfo=None, unique_id=None):
        all_curves = json.loads(all_curves_json)
        adjusted_image_tensor = image

        if image is not None:
            img_batch = [torch.from_numpy(np.array(self.process_image(Image.fromarray(np.clip(255. * i.cpu().numpy(), 0, 255).astype(np.uint8)), all_curves)).astype(np.float32) / 255.0) for i in image]
            adjusted_image_tensor = torch.stack(img_batch)

        adjusted_mask_tensor = mask

        if mask is not None:
            mask_batch = [torch.from_numpy(np.array(self._apply_curve(Image.fromarray((m.cpu().numpy()*255).astype(np.uint8), 'L'), all_curves["mask"])).astype(np.float32) / 255.0) for m in mask]
            adjusted_mask_tensor = torch.stack(mask_batch)

        if unique_id:
            img_base64, mask_base64 = None, None

            if image is not None:
                img_pil_preview = Image.fromarray(np.clip(255. * image[0].cpu().numpy(), 0, 255).astype(np.uint8)); img_pil_preview.thumbnail((768, 768), Image.LANCZOS)
                buffered = BytesIO(); img_pil_preview.save(buffered, format="PNG"); img_base64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

            if mask is not None:
                mask_pil_preview = Image.fromarray((mask[0].cpu().numpy()*255).astype(np.uint8), 'L'); mask_pil_preview.thumbnail((768, 768), Image.LANCZOS)
                buffered = BytesIO(); mask_pil_preview.save(buffered, format="PNG"); mask_base64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

            PromptServer.instance.send_sync("eses.channel_curves_preview", {"node_id": unique_id, "image_data": img_base64, "mask_data": mask_base64})

        return (adjusted_image_tensor, adjusted_mask_tensor, image, mask)


# Histogram calculation logic
def calculate_histogram(pil_img, channel_mode):
    hist = []
    if channel_mode == "RGB":
        hist = ImageOps.grayscale(pil_img).histogram()
    elif channel_mode in ["Red", "Green", "Blue"]:
        channel_map = {"Red": 0, "Green": 1, "Blue": 2}
        r, g, b = pil_img.split()
        channels = [r, g, b]
        hist = channels[channel_map[channel_mode]].histogram()
    elif channel_mode == "Mask":
        hist = pil_img.histogram()
    elif channel_mode in ["Luminosity", "Saturation"]:
        hsv_img = pil_img.convert('HSV')
        h, s, v = hsv_img.split()
        if channel_mode == "Luminosity":
            hist = v.histogram()
        else: # Saturation
            hist = s.histogram()

    if hist:
        max_val = max(hist)
        if max_val > 0:
            hist = [h / max_val for h in hist]
    return hist



# Server ----------

@PromptServer.instance.routes.post("/eses_channel_curves/save_preset")
async def eses_channel_curves_save_preset(request):
    """
    API endpoint to save a new preset to a file.
    """
    try:
        data = await request.json()
        preset_name = data.get("preset_name")
        preset_data = data.get("preset_data")

        if not preset_name or not preset_data:
            return web.json_response({"success": False, "message": "Preset name or data is missing."}, status=400)

        # Sanitize the filename to prevent 
        # security issues like path traversal.
        sanitized_name = preset_name.strip()
        sanitized_name = sanitized_name.replace(" ", "_")
        sanitized_name = re.sub(r'[^\w\-_]', '', sanitized_name)

        if not sanitized_name:
            return web.json_response({"success": False, "message": "Invalid preset name after sanitization."}, status=400)

        file_path = os.path.join(PRESETS_DIR, f"{sanitized_name}.json")

        with open(file_path, 'w', encoding='utf-8') as f:
            json.dump(preset_data, f, indent=4)

        updated_presets = load_presets()
        return web.json_response({"success": True, "message": "Preset saved successfully.", "presets": updated_presets})

    except Exception as e:
        print(f"[EsesChannelCurves] Error saving preset: {e}")
        return web.json_response({"success": False, "message": str(e)}, status=500)


@PromptServer.instance.routes.get("/eses_channel_curves/get_presets")
async def eses_channel_curves_get_presets(request):
    presets = load_presets()
    return web.json_response(presets)


@PromptServer.instance.routes.post("/eses_channel_curves/get_histogram")
async def eses_channel_curves_get_histogram(request):
    data = await request.json()
    base_data_b64 = data.get("base_data_b64")
    channel_mode = data.get("channel_mode", "RGB") # e.g., "RGB", "Red", "Mask"

    if not base_data_b64:
        return web.json_response({"error": "Missing image data"}, status=400)

    try:
        img_bytes = base64.b64decode(base_data_b64)
        img = Image.open(BytesIO(img_bytes)).convert("RGB")

        histogram_data = calculate_histogram(img, channel_mode)

        return web.json_response({"histogram": histogram_data})
    except Exception as e:
        return web.json_response({"error": str(e)}, status=500)


@PromptServer.instance.routes.post("/eses_channel_curves/apply")
async def eses_channel_curves_apply_endpoint(request):
    data = await request.json()
    base_data_b64, all_curves_json, base_data_type = data.get("base_data_b64"), data.get("all_curves_json"), data.get("base_data_type", "image")

    if not base_data_b64 or not all_curves_json: return web.json_response({"error": "Missing data"}, status=400)

    try:
        img_bytes, all_curves = base64.b64decode(base_data_b64), json.loads(all_curves_json)
        base_img = Image.open(BytesIO(img_bytes))

        if base_data_type == 'mask': adjusted_img = EsesImageEffectCurves._apply_curve(base_img.convert("L"), all_curves["mask"])
        else: adjusted_img = EsesImageEffectCurves.process_image(base_img.convert("RGB"), all_curves)
        buffered = BytesIO(); adjusted_img.save(buffered, format="PNG")

        return web.json_response({"adjusted_image_data": base64.b64encode(buffered.getvalue()).decode("utf-8")})

    except Exception as e: return web.json_response({"error": str(e)}, status=500)