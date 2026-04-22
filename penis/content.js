// List of claim-related keywords/phrases
const claimKeywords = [
    "research shows", "scientists say", "it is proven", "experts agree", "according to",
    "studies indicate", "data suggests", "evidence shows", "a study found", "new research",
    "statistically significant", "demonstrates that", "confirms that", "is known to", 
    "has been proven", "results indicate", "scholars argue", "reports suggest", 
    "According to a study", "Researchers found", "Studies show that", "Evidence suggests", 
    "Experts suggest", "Recent findings reveal", "It is believed that", "It has been proven that", 
    "Research indicates that", "Data supports the idea", "It is widely accepted that", 
    "According to experts", "Surveys reveal", "Experts have concluded", "Recent research confirms",
    "The data shows", "There is a consensus that", "A growing body of research suggests",
    "Studies have demonstrated", "Preliminary research indicates", "Findings suggest", 
    "There is evidence to support", "Studies have shown", "Some argue that", "Many studies indicate",
     "Some studies point to", "Emerging evidence suggests", "Research has found", "According to new data",
      "The results of the study show", "A report shows that", "Statistical analysis indicates",
       "Data reveals that", "It is hypothesized that", "It is thought that", 
       "Researcher\’s findings suggest", "In a recent experiment", "Results confirm that",
        "The findings point to", "Studies consistently show", "There is growing evidence",
         "According to a report", "Survey data suggests", "Findings confirm that", "Research shows a correlation", "It is assumed that", "Many believe that", "The research points to", "Longitudinal studies have found", "It is expected that", "Scientific evidence shows", "The research suggests", "Experiments have proven", "According to new findings", "A meta-analysis shows", "The survey results suggest", "A review of studies shows", "Recent studies point to", "Test results suggest", "Findings from this study indicate", "Research suggests that", "Data from this study shows", "The results of the experiment indicate", "Studies report that", "Reports indicate", "Numerous studies have found", "Experts have shown that", "The data confirms", "Statistical tests suggest", "Observational data shows", "Recent evidence confirms", "Surveys suggest that", "The study indicates", "Statistical models indicate", "Empirical research suggests", "Clinical studies show", "The results suggest", "The study found", "It has been suggested that", "The research concludes", "Surveys confirm that", "A study by experts shows", "Scientific analysis shows", "Controlled experiments have shown", "Data from this experiment suggests", "Recent studies suggest", "It is widely believed that", "Research data indicates", "A study confirms", "Findings from research show", "Data supports the conclusion", "Studies reveal that", "Research findings indicate", "Evidence from studies shows", "The research team found", "Recent analysis shows", "The findings reveal", "Numerous studies indicate", "The research supports the claim", "Studies have proven that", "According to a study", "Researchers found", "Studies show that", "Evidence suggests", "Experts suggest", "Recent findings reveal", "It is believed that", "It has been proven that", "Research indicates that", "Data supports the idea", "It is widely accepted that", "According to experts", "Surveys reveal", "Experts have concluded", "Recent research confirms", "The data show", "There is a consensus that", "A growing body of research suggests", "Studies have demonstrated", "Preliminary research indicates", "Findings suggest", "There is evidence to", "Studies have", "Some argue that", "Many studies indicate", "Some studies point to", "Emerging evidence suggests", "Research has", "According to new", "The results of the study show", "A report shows that", "Statistical analysis indicates", "Data reveals that", "It is hypothesized that", "It is thought that", "Researcher\’s findings suggest", "In a recent experiment", "Results confirm that", "The findings point to", "Studies consistently show", "There is growing evidence", "According to a report", "Survey data suggests", "Findings confirm that", "Research shows a correlation", "It is assumed that", "Many believe that", "The research points to", "Longitudinal studies have found", "It is expected that", "Scientific evidence shows", "The research suggests", "Experiments have proven", "According to new findings", "A meta-analysis shows", "The survey results suggest", "A review of studies shows", "Recent studies point to", "Test results suggest", "Findings from this study indicate", "Research suggests that", "Data from this study shows", "The results of the experiment indicate", "Studies report that", "Reports indicate", "Numerous studies have found", "Experts have shown that", "The data confirms", "Statistical tests suggest", "Observational data shows", "Recent evidence confirms", "Surveys suggest that", "The study indicates", "Statistical models indicate", "Empirical research suggests", "Clinical studies show", "The results suggest", "The study found", "It has been suggested that", "The research concludes", "Surveys confirm that", "A study by experts shows", "Scientific analysis shows", "Controlled experiments have shown", "Data from this experiment suggests", "Recent studies suggest", "It is widely believed that", "Research data indicates", "A study confirms", "Findings from research show", "Data supports the conclusion", "Studies reveal that", "Research findings indicate", "Evidence from studies shows", "The research team found", "Recent analysis shows", "The findings reveal", "Numerous studies indicate", "The research supports the claim", "Studies have proven that", "According to a study", "Researchers found", "Studies show that", "Evidence suggests", "Experts suggest", "Recent findings reveal", "It is believed that", "It has been proven that", "Research indicates that", "Data supports the idea", "It is widely accepted that", "According to experts", "Surveys reveal", "Experts have concluded", "Recent research confirms", "The data shows", "There is a consensus that", "A growing body of research suggests", "Studies have demonstrated", "Preliminary research indicates", "Findings suggest", "There is evidence to support", "Studies have shown", "Some argue that", "Many studies indicate", "Some studies point to", "Emerging evidence suggests", "Research has found", "According to new data", "The results of the study show", "A report shows that", "Statistical analysis indicates", "Data reveals that", "It is hypothesized that", "It is thought that", "Researcher\’s findings suggest", "In a recent experiment", "Results confirm that", "The findings point to", "Studies consistently show", "There is growing evidence", "According to a report", "Survey data suggests", "Findings confirm that", "Research shows a correlation", "It is assumed that", "Many believe that", "The research points to", "Longitudinal studies have found", "It is expected that", "Scientific evidence shows", "The research suggests", "Experiments have proven", "According to new findings", "A meta-analysis shows", "The survey results suggest", "A review of studies shows", "Recent studies point to", "Test results suggest", "Findings from this study indicate", "Research suggests that", "Data from this study shows", "The results of the experiment indicate", "Studies report that", "Reports indicate", "Numerous studies have found", "Experts have shown that", "The data confirms", "Statistical tests suggest", "Observational data shows", "Recent evidence confirms", "Surveys suggest that", "The study indicates", "Statistical models indicate", "Empirical research suggests", "Clinical studies show", "The results suggest", "The study found", "It has been suggested that", "The research concludes", "Surveys confirm that", "A study by experts shows", "Scientific analysis shows", "Controlled experiments have shown", "Data from this experiment suggests", "Recent studies suggest", "It is widely believed that", "Research data indicates", "A study confirms", "Findings from research show", "Data supports the conclusion", "Studies reveal that", "Research findings indicate", "Evidence from studies shows", "The research team found", "Recent analysis shows", "The findings reveal", "Numerous studies indicate", "The research supports the claim", "Studies have proven that"
];

// Function to extract text from the page
function getAllText() {
    let textElements = document.body.querySelectorAll("p, h1, h2, h3, h4, h5, h6");
    let textContent = [];

    textElements.forEach(element => {
        let style = window.getComputedStyle(element);
        if (element.offsetParent === null || style.visibility === "hidden" || style.display === "none") {
            return;
        }

        let text = element.textContent.trim();
        
        // Remove problematic control characters, including tabs
        text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\t]/g, "");

        if (text.length > 0) {
            textContent.push({ element, text }); // Store element reference + text
        }
    });

    return textContent;
}

// Function to detect claims and highlight them
function detectClaims() {
    let extractedText = getAllText();
    console.log("Extracted Text: ", extractedText);

    extractedText.forEach(({ element, text }) => {
        claimKeywords.forEach(keyword => {
            if (text.toLowerCase().includes(keyword)) {
                highlightText(element, keyword);
            }
        });
    });
}

// Function to highlight detected claim keywords safely
function highlightText(element, keyword) {
    let innerHTML = element.innerHTML;
    
    // Escape keyword to prevent regex issues
    let safeKeyword = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    
    let regex = new RegExp(`(${safeKeyword})`, "gi");

    // Ensure we're modifying only text content, not breaking innerHTML
    let newHTML = innerHTML.replace(regex, `<span style="background-color: yellow; font-weight: bold;">$1</span>`);

    // Only update if there's a change to prevent unnecessary re-renders
    if (newHTML !== innerHTML) {
        element.innerHTML = newHTML;
    }
}

// Run claim detection
detectClaims();
