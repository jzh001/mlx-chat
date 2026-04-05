# MLX Chat UI

## Existing Tools and Limitations
Currently, existing tools like Ollama and LM Studio run mostly on llama.cpp and GGUF models. There are some efforts to integrate with MLX, but they are still not as memory efficient as running with `mlx_vlm`. For example, take the model on HuggingFace `mlx-community/gemma-4-26b-a4b-it-4bit`. It generates tokens really slowly on LM Studio or Ollama with a super limited context window, when I run on my Mac Hardware (Mac Mini M4 Pro 24GB). However, on `mlx_vlm` with the same hardware, the tokens are generated blazing fast with a long context window supported.

Additionally, Ollama and LM Studio do not support new memory efficient methods like TurboQuant, but `mlx_vlm` does.

`mlx_vlm`'s main limitation is that it does not have a (good) UI. It does have a chat_ui interface with Gradio, but it looks very bad and does not do some of the formula parsing correctly. Additionally, the color scheme and font is not very professional. Additionally, you have to spin it up from the terminal which makes it inconvenient for the regular user.

## TODO
You will create a user-friendly Mac application which exposes a customizable Chat UI to the user, which runs `mlx-community` models under the hood on Apple Silicon with `mlx_vlm`. Below are the detailed specifications:

### Features
1. Chat UI with customizable features for generation settings (e.g. temperature, top-p, max tokens, repetitition sampling, system prompt) and model selection. The ChatUI should look professional (similar to ChatGPT UI, or Ollama / LM Studio UI) with good parsing for Markdown text and formula.
2. An easy model management tab to manage all downloaded `mlx-community` models, similar to what we have for LM studio. When loading existing models, searching for new models or downloading new models, there should be a note to show whether the model allows for full GPU offload, partial GPU offload or likely too large, similar to LM studio. All models should be from the HuggingFace `mlx-community` series. For downloading models, please also add a progress bar.
3. Support for latest features from `mlx_vlm`, such as TurboQuant. This should also be one of the options I can select from. 
4. Automatically save any of the generation / configuration settings for each model.

### Design Considerations
1. The purpose of this app is to run more more efficiently than Ollama or LM Studio, so it should not have too much memory bloat for the UI. Keep the memory used for the app to a minimal. The app should be lean and simple, while implementing all of the features above. This is especially because many of the slightly larger local models can take up almost all the Unified Memory in the Mac, and there might be very little room for the UI app.
2. The app should be easy to install and use. Developers can either clone the GitHub repository of this code repository and install it themselves, or non-users with Apple Macs can also download direct application files.
3. Include proper documentation in a README.md file.



## Important Guidelines
- If you are unsure of some of the latest technologies (e.g. TurboQuant), make sure to search for the latest papers / documentation. For example, `mlx_vlm` recently added support for TurboQuant.
- For `mlx_vlm`, currently `mlx-community/gemma-4-26b-a4b-it-4bit` is already downloaded, let's use that for the bulk of our development and testing. Of course, we should have the option to select other `mlx-community` models.
- If you are unsure about any aspects of the implementation, do not hesitate to ask me for help.