import torch
import torch_directml
import os

# Toggle this to True for using only the first 1000 samples
LIMIT_DATASET = True
DATASET_SIZE = 1000  # Change this to modify the number of samples used when LIMIT_DATASET is True

# Check if DirectML is available
try:
    device = torch_directml.device()
    print("DirectML is available and will be used.")
except Exception as e:
    print(f"DirectML is not available: {e}")
    device = torch.device("cpu")  # Fallback to CPU if DirectML is unavailable

# Load the model
from transformers import BertForSequenceClassification

model = BertForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=2)

# Move model to the DirectML device (or CPU if DirectML is unavailable)
model.to(device)

# Load the dataset
from datasets import load_dataset
from transformers import BertTokenizer, Trainer, TrainingArguments, DataCollatorWithPadding
import json

print(f"Using device: {device}")

dataset = load_dataset("Nithiwat/claim-detection")

# Limit dataset size if needed
if LIMIT_DATASET:
    dataset["train"] = dataset["train"].select(range(min(DATASET_SIZE, len(dataset["train"]))))
    dataset["test"] = dataset["test"].select(range(min(DATASET_SIZE, len(dataset["test"]))))
    print(f"Using only the first {DATASET_SIZE} samples for training and testing.")

# Load the BERT tokenizer
tokenizer = BertTokenizer.from_pretrained("bert-base-uncased")

# Preprocessing function to tokenize the text data
def preprocess_function(examples):
    return tokenizer(examples['text'], truncation=True, padding='max_length', max_length=512)

# Tokenize the datasets
tokenized_datasets = dataset.map(preprocess_function, batched=True)

# Rename the 'checkworthiness' column to 'labels' to match the model's expected input format
tokenized_datasets = tokenized_datasets.rename_column("checkworthiness", "labels")

# Set the format of the dataset to PyTorch tensors
tokenized_datasets.set_format(type="torch", columns=["input_ids", "attention_mask", "labels"])

print(f"Unique classes in the 'checkworthiness' column: {set(dataset['train']['checkworthiness'])}")

# Reload the model to ensure it's using the correct device
model = BertForSequenceClassification.from_pretrained("bert-base-uncased", num_labels=2)

# Move model to the DirectML device
model.to(device)

# Prepare the training arguments
training_args = TrainingArguments(
    output_dir="./results",
    eval_strategy="epoch",
    save_strategy="epoch",
    per_device_train_batch_size=8,
    per_device_eval_batch_size=8,
    num_train_epochs=1,
    weight_decay=0.01,
    logging_dir="./logs",
    logging_steps=200,
    save_steps=200,
    load_best_model_at_end=True,
    metric_for_best_model="accuracy"
)

# Define a compute_metrics function to calculate evaluation metrics
def compute_metrics(p):
    from sklearn.metrics import accuracy_score
    preds = p.predictions.argmax(axis=-1)
    return {"accuracy": accuracy_score(p.label_ids, preds)}

# Create the data collator to handle padding dynamically
data_collator = DataCollatorWithPadding(tokenizer)

# Set up the Trainer
trainer = Trainer(
    model=model,
    args=training_args,
    train_dataset=tokenized_datasets["train"],
    eval_dataset=tokenized_datasets["test"],
    compute_metrics=compute_metrics,
    data_collator=data_collator,
)

# Start training
trainer.train()

# Ensure the directory exists
os.makedirs("./final_model", exist_ok=True)

# Save the config file
config = model.config.to_dict()
with open("./final_model/config.json", "w") as config_file:
    json.dump(config, config_file)

# Save the model's state_dict (weights) as a binary file
model.save_pretrained("./final_model")

# Optionally, save the tokenizer as well
tokenizer.save_pretrained("./final_model")

# Save the trained model in the format required for your project
trainer.save_model("./final_model")

# Evaluate the model on the test set
results = trainer.evaluate()
print("Test Results:", results)
